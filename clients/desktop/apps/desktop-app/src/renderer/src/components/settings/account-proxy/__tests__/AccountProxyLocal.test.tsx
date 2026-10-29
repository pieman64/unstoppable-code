/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AccountProxyLocalRuntime,
  AccountProxyStatus,
} from '@canopy/desktop-shared/types/account-proxy';
import {
  AccountProxyAddAccount,
  AccountProxyLocalConnection,
  AccountProxyLocalSetup,
} from '../AccountProxyLocal';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useAccountProxyStore } from '@/stores/accountProxyStore';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

const LOCAL: AccountProxyLocalRuntime = {
  phase: 'running',
  version: '8.0.28',
  install: null,
  port: 21455,
  startWithApp: true,
  message: null,
};

function statusWith(
  local: Partial<AccountProxyLocalRuntime>,
  extra: Partial<AccountProxyStatus> = {},
): AccountProxyStatus {
  return {
    available: true,
    connection: {
      id: 'local-1',
      kind: 'local',
      url: 'http://127.0.0.1:21455',
    },
    state: 'connected',
    error: null,
    version: '8.0.28',
    accounts: [],
    routing: null,
    keepChatOnOneAccount: true,
    routeClaude: true,
    routeCodex: true,
    refreshedAt: 1,
    local: { ...LOCAL, ...local },
    signIn: null,
    ...extra,
  };
}

const api = {
  status: jest.fn(),
  setUpLocal: jest.fn(),
  controlLocal: jest.fn(),
  signIn: jest.fn(),
  disconnect: jest.fn(),
};
const savePreferences = jest.fn(() => Promise.resolve());

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.controlLocal.mockResolvedValue(statusWith({}));
  api.signIn.mockResolvedValue(statusWith({}));
  api.status.mockResolvedValue(statusWith({}));
  savePreferences.mockClear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { accountProxy: api, savePreferences },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

function byTestId(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}

async function click(id: string): Promise<void> {
  await act(async () => {
    byTestId(id).click();
    await Promise.resolve();
  });
}

describe('setting up the proxy on this device', () => {
  it('offers to download it and shows why a start failed', async () => {
    api.setUpLocal.mockResolvedValue({
      ok: false,
      error: {
        code: 'local-failed',
        message: 'Account proxy download checksum did not match. Try again.',
      },
    });
    render(
      <AccountProxyLocalSetup local={{ ...LOCAL, phase: 'not-installed' }} />,
    );
    expect(byTestId('account-proxy-local-setup').textContent).toContain(
      'Downloads CLIProxyAPI 8.0.28',
    );
    expect(byTestId('account-proxy-local-start').textContent).toBe(
      'Download and start',
    );
    await click('account-proxy-local-start');
    expect(api.setUpLocal).toHaveBeenCalledTimes(1);
    expect(byTestId('account-proxy-local-error').textContent).toBe(
      'Account proxy download checksum did not match. Try again.',
    );
  });

  it('shows download progress', () => {
    render(
      <AccountProxyLocalSetup
        local={{
          ...LOCAL,
          phase: 'installing',
          install: { step: 'downloading', percent: 42 },
        }}
      />,
    );
    expect(byTestId('account-proxy-local-installing').textContent).toContain(
      'Downloading CLIProxyAPI 8.0.28… 42%',
    );
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute('aria-valuenow'),
    ).toBe('42');
  });
});

describe('the proxy on this device as the connection', () => {
  it('shows where it runs and stops it', async () => {
    render(<AccountProxyLocalConnection status={statusWith({})} />);
    expect(byTestId('account-proxy-local-connection').textContent).toContain(
      'Running · version 8.0.28 · 127.0.0.1:21455',
    );
    await click('account-proxy-local-stop');
    expect(api.controlLocal).toHaveBeenCalledWith({ action: 'stop' });
  });

  it('restarts it', async () => {
    render(<AccountProxyLocalConnection status={statusWith({})} />);
    await click('account-proxy-local-restart');
    expect(api.controlLocal).toHaveBeenCalledWith({ action: 'restart' });
  });

  it('shows why it stopped and starts it again', async () => {
    render(
      <AccountProxyLocalConnection
        status={statusWith({
          phase: 'error',
          message: 'The account proxy stopped (code 2).',
        })}
      />,
    );
    expect(byTestId('account-proxy-local-error').textContent).toBe(
      'The account proxy stopped (code 2).',
    );
    expect(byTestId('account-proxy-local-start').textContent).toBe('Try again');
    await click('account-proxy-local-start');
    expect(api.controlLocal).toHaveBeenCalledWith({ action: 'start' });
  });

  it('keeps the proxy output out of session replays', () => {
    render(
      <AccountProxyLocalConnection
        status={statusWith({
          phase: 'error',
          message: 'The account proxy did not start: /home/someone/secret',
        })}
      />,
    );
    const message = byTestId('account-proxy-local-error').querySelector(
      `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
    );
    expect(message?.textContent).toContain('/home/someone/secret');
  });

  it('keeps a failed start message out of session replays', async () => {
    api.setUpLocal.mockResolvedValue({
      ok: false,
      error: { code: 'local-failed', message: 'Failed in /home/someone/x' },
    });
    render(<AccountProxyLocalSetup local={{ ...LOCAL, phase: 'stopped' }} />);
    await act(async () => {
      byTestId('account-proxy-local-start').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const blocked = host.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`);
    expect(blocked?.textContent).toContain('/home/someone/x');
  });

  it('shows the connection error with the proxy status', () => {
    render(
      <AccountProxyLocalConnection
        status={statusWith(
          {},
          {
            state: 'error',
            error: { code: 'local-failed', message: 'Read /home/someone/y' },
          },
        )}
      />,
    );
    const shown = byTestId('account-proxy-local-connection-error');
    expect(shown.textContent).toContain('/home/someone/y');
    expect(
      shown.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
  });

  it('saves whether it starts with the app', async () => {
    render(<AccountProxyLocalConnection status={statusWith({})} />);
    await act(async () => {
      byTestId('account-proxy-local-start-with-app').click();
      await Promise.resolve();
    });
    expect(savePreferences).toHaveBeenCalledWith({
      accountProxyLocalStartWithApp: false,
    });
  });

  it('shows the saved start-with-app setting without waiting for a refresh', async () => {
    api.status.mockResolvedValue(statusWith({ startWithApp: false }));
    render(<AccountProxyLocalConnection status={statusWith({})} />);
    await act(async () => {
      byTestId('account-proxy-local-start-with-app').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.status).toHaveBeenCalled();
    expect(useAccountProxyStore.getState().status?.local?.startWithApp).toBe(
      false,
    );
  });
});

describe('adding an account to the proxy on this device', () => {
  it('shows why Try again did not start and drops the stale row', async () => {
    api.signIn.mockRejectedValue(new Error('A sign-in is already starting.'));
    api.status.mockResolvedValue(statusWith({}));
    render(
      <AccountProxyAddAccount
        status={statusWith(
          {},
          {
            signIn: { provider: 'claude', phase: 'failed', message: 'Nope' },
          },
        )}
      />,
    );
    await act(async () => {
      byTestId('account-proxy-sign-in-retry').click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(byTestId('account-proxy-add-account-error').textContent).toContain(
      'A sign-in is already starting.',
    );
    expect(useAccountProxyStore.getState().status?.signIn).toBeNull();
  });

  it('waits for the proxy to run', () => {
    render(
      <AccountProxyAddAccount status={statusWith({ phase: 'stopped' })} />,
    );
    expect(byTestId('account-proxy-add-account').hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('signs in with the provider picked from the menu', async () => {
    render(<AccountProxyAddAccount status={statusWith({})} />);
    await click('account-proxy-add-account');
    // The provider logo sits in the row's standard icon slot.
    const slot = byTestId('account-proxy-add-account-codex').firstElementChild;
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.querySelector('svg')).toBeInstanceOf(Element);
    await click('account-proxy-add-account-codex');
    expect(api.signIn).toHaveBeenCalledWith({
      action: 'start',
      provider: 'codex',
    });
  });

  it('offers to open the browser again or cancel while it waits', async () => {
    render(
      <AccountProxyAddAccount
        status={statusWith(
          {},
          { signIn: { provider: 'claude', phase: 'waiting', message: null } },
        )}
      />,
    );
    expect(byTestId('account-proxy-sign-in').textContent).toContain(
      'Finish signing in in your browser.',
    );
    await click('account-proxy-sign-in-reopen');
    expect(api.signIn).toHaveBeenCalledWith({ action: 'reopen' });
    await click('account-proxy-sign-in-cancel');
    expect(api.signIn).toHaveBeenCalledWith({ action: 'cancel' });
  });

  it('shows why a sign-in failed', () => {
    render(
      <AccountProxyAddAccount
        status={statusWith(
          {},
          {
            signIn: {
              provider: 'claude',
              phase: 'failed',
              message: 'Sign-in timed out. Try again.',
            },
          },
        )}
      />,
    );
    expect(byTestId('account-proxy-sign-in-error').textContent).toBe(
      'Sign-in timed out. Try again.',
    );
  });
});
