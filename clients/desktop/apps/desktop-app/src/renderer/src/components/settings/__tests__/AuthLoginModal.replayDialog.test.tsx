/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): the provider sign-in modal hosts a live login terminal (and,
// for Codex, a device code). `DialogModal` records its card, so the terminal
// host and the device code carry their own blocks. This pins that the xterm
// host, the terminal xterm mounts into it, and the Codex device code all render
// in blocked regions of the recorded card.

// jsdom cannot construct xterm. This stand-in mounts a `.xterm` element into
// the host the way the real terminal does and renders written output into it,
// so the test can find the terminal DOM a recorder would see.
jest.mock('@xterm/xterm', () => {
  class FakeTerminal {
    cols = 80;
    rows = 24;
    buffer = { active: { viewportY: 0 } };
    private screen: HTMLElement | null = null;

    open(parent: HTMLElement): void {
      const screen = parent.ownerDocument.createElement('div');
      screen.className = 'xterm';
      parent.appendChild(screen);
      this.screen = screen;
    }

    write(data: string): void {
      if (this.screen) this.screen.textContent += data;
    }

    loadAddon(): void {}

    focus(): void {}

    getSelection(): string {
      return '';
    }

    getSelectionPosition(): undefined {
      return undefined;
    }

    onData(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    }

    onSelectionChange(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    }

    onScroll(): { dispose: () => void } {
      return { dispose: (): void => undefined };
    }

    dispose(): void {
      this.screen?.remove();
      this.screen = null;
    }
  }
  return { Terminal: FakeTerminal };
});
jest.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
jest.mock('@canopy/ui-app/terminal', () => ({
  installTerminalLinks: (): (() => void) => (): void => undefined,
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: jest.fn(),
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AuthTerminalOutputEvent,
  CodexLoginState,
} from '@canopy/desktop-shared/types';
import { useObservabilityStore } from '@/stores/observabilityStore';
import { AuthLoginModal } from '../AuthLoginModal';
import {
  expectBlockedInRecordedDialogCard,
  expectInRecordedDialogCard,
  expectReplayBlocksOnlyValue,
} from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TERMINAL_OUTPUT = 'Enter one-time code: 9F4K-22QX';
const DEVICE_CODE = 'WXYZ-7781';

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('AuthLoginModal session replay', () => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const initialObservability = useObservabilityStore.getState();
  let outputListener: ((event: AuthTerminalOutputEvent) => void) | null;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    outputListener = null;
    useObservabilityStore.setState({
      initialize: jest.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getGitHubCliStatus: jest.fn().mockResolvedValue({
          installed: true,
          authenticated: false,
          username: null,
          error: null,
        }),
        browser: { openExternal: jest.fn().mockResolvedValue(undefined) },
        authTerminal: {
          start: jest.fn().mockResolvedValue({ sessionId: 'session-1' }),
          write: jest.fn().mockResolvedValue(undefined),
          resize: jest.fn().mockResolvedValue(undefined),
          stop: jest.fn().mockResolvedValue(undefined),
          onOutput: (
            listener: (event: AuthTerminalOutputEvent) => void,
          ): (() => void) => {
            outputListener = listener;
            return (): void => {
              outputListener = null;
            };
          },
          onExit: (): (() => void) => (): void => undefined,
        },
        codexLogin: {
          start: jest.fn().mockResolvedValue({
            attemptId: 'attempt-1',
            phase: 'waiting',
            activeWorkCount: 0,
            method: 'chatgptDeviceCode',
            userCode: DEVICE_CODE,
          } satisfies CodexLoginState),
          cancel: jest.fn().mockResolvedValue({
            attemptId: null,
            phase: 'ready',
            activeWorkCount: 0,
          } satisfies CodexLoginState),
          retryVerification: jest.fn(),
          openBrowser: jest.fn().mockResolvedValue(undefined),
          onState: (): (() => void) => (): void => undefined,
        },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    useObservabilityStore.setState(initialObservability, true);
    if (originalApi) {
      Object.defineProperty(window, 'api', originalApi);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('blocks the login terminal and its output inside the recorded DialogModal card', async () => {
    await act(async () => {
      root.render(
        <AuthLoginModal provider="github" onClose={(): void => undefined} />,
      );
      await Promise.resolve();
    });
    await flushAsync();

    const host = document.querySelector('[data-testid="auth-login-terminal"]');
    if (host === null) throw new Error('Terminal host not rendered');
    expect(container.contains(host)).toBe(false);
    const card = expectBlockedInRecordedDialogCard(host);
    expect(card.getAttribute('aria-labelledby')).toBe('dialog-modal-title');

    act(() => {
      outputListener?.({ sessionId: 'session-1', data: TERMINAL_OUTPUT });
    });
    const screen = host.querySelector('.xterm');
    if (screen === null) throw new Error('Terminal was not mounted');
    expect(screen.textContent).toContain(TERMINAL_OUTPUT);
    expect(expectBlockedInRecordedDialogCard(screen)).toBe(card);
  });

  it('blocks only the signed-in account label inside the recorded DialogModal card', async () => {
    jest.mocked(window.api.getGitHubCliStatus).mockResolvedValue({
      installed: true,
      authenticated: true,
      username: 'octo-ada',
      error: null,
    });
    await act(async () => {
      root.render(
        <AuthLoginModal provider="github" onClose={(): void => undefined} />,
      );
      await Promise.resolve();
    });
    await flushAsync();

    const status = document.querySelector('[data-testid="auth-login-status"]');
    if (status === null) throw new Error('Status footer not rendered');
    expect(status.textContent).toContain('Signed in as octo-ada');
    // The footer and its copy stay recorded; only the login is blocked.
    expectInRecordedDialogCard(status);
    expectReplayBlocksOnlyValue(status, 'octo-ada');
  });

  it('blocks the Codex device code inside the recorded DialogModal card', async () => {
    await act(async () => {
      root.render(
        <AuthLoginModal provider="codex" onClose={(): void => undefined} />,
      );
      await Promise.resolve();
    });
    await flushAsync();

    const code = document.querySelector(
      '[data-testid="codex-login-device-code"]',
    );
    if (code === null) throw new Error('Device code not rendered');
    expect(code.textContent).toBe(DEVICE_CODE);
    expect(container.contains(code)).toBe(false);
    expectBlockedInRecordedDialogCard(code);
  });
});
