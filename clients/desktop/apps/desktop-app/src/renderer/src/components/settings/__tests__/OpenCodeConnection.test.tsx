/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCodeConnection } from '../OpenCodeConnection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('OpenCode connection placement', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        opencodeConnection: {
          status: () =>
            Promise.resolve({
              supported: true,
              installed: true,
              enabled: true,
              phase: 'idle',
              version: 'test',
            }),
          onProgress: (): (() => void) => (): void => undefined,
          cancel: () => Promise.resolve(),
        },
        loadPreferences: () => Promise.resolve({}),
      },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderConnection(
    placement?: 'row' | 'section',
  ): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        placement ? (
          <OpenCodeConnection placement={placement} />
        ) : (
          <OpenCodeConnection />
        ),
      );
      await Promise.resolve();
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="opencode-connection"]',
    );
    if (!row) throw new Error('Missing OpenCode row');
    return row;
  }

  it('is one provider row, named in its label, when placed beside other providers', async () => {
    const row = await renderConnection('row');
    // The caller's provider group owns the box; the row adds no section or
    // heading of its own.
    expect(container.firstElementChild).toBe(row);
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('h2')).toBeNull();
    expect(
      row.querySelector('[data-settings-row-label]')?.textContent?.trim(),
    ).toBe('OpenCode');
    expect(
      row.querySelector('[data-testid="opencode-connection-status"]')
        ?.textContent,
    ).toBe('OpenCode connected');
  });

  it('keeps its own untitled section in Labs', async () => {
    const row = await renderConnection();
    const section = container.firstElementChild;
    expect(section?.tagName).toBe('SECTION');
    expect(section?.contains(row)).toBe(true);
    // The row names OpenCode, so a heading would repeat it.
    expect(container.querySelector('h2')).toBeNull();
  });
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

describe('OpenCode provider action', () => {
  it.each([
    { installed: false, enabled: false, label: null },
    { installed: true, enabled: false, label: 'Sign in to a provider' },
    { installed: true, enabled: true, label: 'Manage providers' },
  ])(
    'matches setup state $installed/$enabled',
    async ({ installed, enabled, label }) => {
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          opencodeConnection: {
            status: () =>
              Promise.resolve({
                supported: true,
                installed,
                enabled,
                phase: 'idle',
                version: 'test',
              }),
            onProgress: (): (() => void) => (): void => undefined,
          },
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
        const providerAction = container.querySelector(
          '[data-testid="opencode-provider-login"]',
        );
        if (label === null) {
          expect(providerAction).toBeNull();
        } else {
          expect(providerAction?.textContent).toBe(label);
          // Provider management uses the same compact control group as connection.
          expect(providerAction?.parentElement).toBe(
            container.querySelector('[data-testid="opencode-connect"]')
              ?.parentElement,
          );
        }
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );
});
