/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types';
import { CopilotConnection } from '../CopilotConnection';
import {
  expectReplayBlocksOnlyValue,
  outermostReplayBlock,
} from '@/test-utils/replay';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    promise,
    resolve(value): void {
      if (!resolve) throw new Error('Missing resolver');
      resolve(value);
    },
    reject(reason): void {
      if (!reject) throw new Error('Missing rejecter');
      reject(reason);
    },
  };
}

const connected: CopilotConnectionStatus = {
  supported: true,
  installed: true,
  enabled: true,
  phase: 'connected',
  version: 'test',
  account: { host: 'github.com', login: 'copilot-test' },
};

describe('Copilot setup probe ownership', () => {
  let container: HTMLDivElement;
  let root: Root;
  let account: ReturnType<typeof deferred<null>>;
  let mutation: ReturnType<typeof deferred<void>>;
  const status = jest.fn();
  const disconnect = jest.fn();

  beforeEach(() => {
    account = deferred<null>();
    mutation = deferred<void>();
    status.mockReset().mockResolvedValue(connected);
    disconnect
      .mockReset()
      .mockImplementation((): Promise<void> => mutation.promise);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        copilotConnection: {
          status,
          account: () => account.promise,
          disconnect,
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

  it('ignores a probe cancelled by a successful disconnect', async () => {
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    const button = container.querySelector('[data-testid="copilot-connect"]');
    if (!(button instanceof HTMLButtonElement))
      throw new Error('Missing disconnect');
    status.mockResolvedValue({
      ...connected,
      enabled: false,
      account: null,
      phase: 'idle',
    });
    await act(async () => {
      button.click();
      account.reject(new Error('Account probe aborted by mutation'));
      await Promise.resolve();
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    await act(async () => {
      mutation.resolve(undefined);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Ready to connect');
    expect(container.textContent).not.toContain(
      'Could not check Copilot setup',
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('still reports a failed probe when no user action supersedes it', async () => {
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    await act(async () => {
      account.reject(new Error('Account probe failed'));
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Could not check Copilot setup');
  });

  it('shows the signed-in login', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        copilotConnection: {
          status,
          account: () => Promise.resolve(connected.account),
          disconnect,
          onProgress: (): (() => void) => (): void => undefined,
          cancel: () => Promise.resolve(),
        },
        loadPreferences: () => Promise.resolve({}),
      },
    });
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    const line = container.querySelector(
      '[data-testid="copilot-connection-account"]',
    );
    expect(line?.textContent).toBe('Signed in as copilot-test');
    // Session replay blocks the login, not the line or the account actions.
    expectReplayBlocksOnlyValue(container, 'copilot-test');
    expect(outermostReplayBlock(line)).toBeNull();
    const connect = container.querySelector('[data-testid="copilot-connect"]');
    expect(connect).not.toBeNull();
    expect(outermostReplayBlock(connect)).toBeNull();
  });
});

describe('Copilot device-code presentation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let progress: ((value: CopilotConnectionStatus) => void) | undefined;
  const openExternal = jest.fn((): Promise<void> => Promise.resolve());
  const idle: CopilotConnectionStatus = {
    supported: true,
    installed: true,
    enabled: false,
    phase: 'idle',
    version: 'test',
    account: null,
  };
  beforeEach(() => {
    progress = undefined;
    openExternal.mockClear();
    const connect = jest.fn(
      (): Promise<CopilotConnectionStatus> =>
        new Promise<CopilotConnectionStatus>(() => undefined),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        copilotConnection: {
          status: (): Promise<CopilotConnectionStatus> => Promise.resolve(idle),
          account: (): Promise<null> => Promise.resolve(null),
          connect,
          cancel: (): Promise<void> => Promise.resolve(),
          onProgress: (
            callback: (value: CopilotConnectionStatus) => void,
          ): (() => void) => {
            progress = callback;
            return (): void => undefined;
          },
        },
        browser: { openExternal },
        loadPreferences: (): Promise<Record<string, never>> =>
          Promise.resolve({}),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows the code with copy and open actions while authorizing', async () => {
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copilot-connect"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      progress?.({
        ...idle,
        phase: 'authorizing',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="copilot-connection-status"]')
        ?.textContent,
    ).toBe('Enter this code on GitHub to connect Copilot');
    // Screen readers announce the status, so the code itself needs a name.
    expect(
      container
        .querySelector('[data-testid="copilot-device-code"]')
        ?.getAttribute('aria-label'),
    ).toBe('Device code ABCD-1234');
    expect(
      container.querySelector('[data-testid="copilot-device-code"]')
        ?.textContent,
    ).toBe('ABCD-1234');
    expect(
      container.querySelector('[data-testid="copilot-copy-code"]'),
    ).not.toBeNull();
    // The code is a live sign-in secret; its copy action stays recorded.
    expect(
      container
        .querySelector('[data-testid="copilot-device-code"]')
        ?.classList.contains('ph-no-capture'),
    ).toBe(true);
    expect(
      container
        .querySelector('[data-testid="copilot-copy-code"]')
        ?.closest('.ph-no-capture'),
    ).toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copilot-open-github"]')
        ?.click();
      await Promise.resolve();
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://github.com/login/device',
    });
    await act(async () => {
      progress?.({ ...idle, phase: 'checking' });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="copilot-connection-status"]')
        ?.textContent,
    ).toBe('Checking Copilot access…');
    expect(
      container.querySelector('[data-testid="copilot-device-code"]'),
    ).toBeNull();
  });
});

describe('Copilot connection errors', () => {
  let container: HTMLDivElement;
  let root: Root;
  const idle: CopilotConnectionStatus = {
    supported: true,
    installed: true,
    enabled: false,
    phase: 'idle',
    version: 'test',
    account: null,
  };
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        copilotConnection: {
          status: (): Promise<CopilotConnectionStatus> => Promise.resolve(idle),
          account: (): Promise<null> => Promise.resolve(null),
          connect: (): Promise<CopilotConnectionStatus> =>
            Promise.reject(
              new Error(
                "Error invoking remote method 'copilot-connection:connect': Error: GitHub sign-in was declined.",
              ),
            ),
          cancel: (): Promise<void> => Promise.resolve(),
          onProgress: (): (() => void) => (): void => undefined,
        },
        loadPreferences: (): Promise<Record<string, never>> =>
          Promise.resolve({}),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('does not report an error when the user cancels', async () => {
    let rejectConnect: ((reason: Error) => void) | undefined;
    const api = window.api.copilotConnection;
    Object.defineProperty(api, 'connect', {
      configurable: true,
      value: (): Promise<CopilotConnectionStatus> =>
        new Promise<CopilotConnectionStatus>((_resolve, reject) => {
          rejectConnect = reject;
        }),
    });
    Object.defineProperty(api, 'cancel', {
      configurable: true,
      value: (): Promise<void> => {
        rejectConnect?.(
          Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          }),
        );
        return Promise.resolve();
      },
    });
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copilot-connect"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copilot-cancel"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="copilot-connection-error"]'),
    ).toBeNull();
  });

  it('shows the failure without the IPC wrapper', async () => {
    await act(async () => {
      root.render(<CopilotConnection />);
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="copilot-connect"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="copilot-connection-error"]')
        ?.textContent,
    ).toBe('GitHub sign-in was declined.');
  });
});
