/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import {
  resetAccountProxyStoreForTest,
  refreshAccountProxyStatus,
  useAccountProxyStatus,
  useAccountProxyLiveRefresh,
  ACCOUNT_PROXY_REFRESH_INTERVAL_MS,
} from '../accountProxyStore';

const neverRead: AccountProxyStatus = {
  available: true,
  connection: { id: 'c1', kind: 'server', url: 'https://proxy.example.com' },
  state: 'connected',
  error: null,
  version: null,
  accounts: [],
  routing: null,
  keepChatOnOneAccount: true,
  routeClaude: true,
  routeCodex: true,
  refreshedAt: null,
  local: {
    phase: 'not-installed',
    version: null,
    install: null,
    port: null,
    startWithApp: true,
    message: null,
  },
  signIn: null,
};

function Probe(): JSX.Element {
  useAccountProxyStatus();
  return <></>;
}

function LiveProbe(): JSX.Element {
  useAccountProxyLiveRefresh(true);
  return <></>;
}

describe('accountProxyStore', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetAccountProxyStoreForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    resetAccountProxyStoreForTest();
    jest.useRealTimers();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  async function mountWith(initial: AccountProxyStatus): Promise<jest.Mock> {
    const status = jest.fn(
      (options?: { refresh?: boolean; refreshUsage?: boolean }) =>
        Promise.resolve(
          options?.refresh ? { ...initial, refreshedAt: 2 } : initial,
        ),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        accountProxy: {
          status,
          onChanged: (): (() => void) => (): void => undefined,
        },
      },
    });
    await act(async () => {
      root.render(<Probe />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    return status;
  }

  it('reads a saved connection that main has not read since launch', async () => {
    // After a restart main has the connection but no account list yet, so
    // the model picker would treat proxy-only models as unavailable.
    const status = await mountWith(neverRead);
    expect(status).toHaveBeenCalledWith({ refresh: true, refreshUsage: false });
  });

  it('does not refresh a connection main has already read', async () => {
    const status = await mountWith({ ...neverRead, refreshedAt: 1 });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('requests fresh quotas on an explicit user refresh', async () => {
    const status = await mountWith({ ...neverRead, refreshedAt: 1 });
    await act(async () => {
      await refreshAccountProxyStatus();
    });
    expect(status).toHaveBeenLastCalledWith({
      refresh: true,
      refreshUsage: true,
    });
  });

  it('follows an in-flight inventory refresh with queued quota demand', async () => {
    const status = await mountWith({ ...neverRead, refreshedAt: 1 });
    let finishInventory: (value: AccountProxyStatus) => void = () => undefined;
    status.mockImplementationOnce(
      () =>
        new Promise<AccountProxyStatus>((resolve) => {
          finishInventory = resolve;
        }),
    );
    await act(async () => {
      const inventory = refreshAccountProxyStatus({ refreshUsage: false });
      void refreshAccountProxyStatus({ refreshUsage: true });
      void refreshAccountProxyStatus({ refreshUsage: true });
      await Promise.resolve();
      finishInventory({ ...neverRead, refreshedAt: 2 });
      await inventory;
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });
    expect(status.mock.calls.slice(1)).toEqual([
      [{ refresh: true, refreshUsage: false }],
      [{ refresh: true, refreshUsage: true }],
    ]);
  });

  it('refreshes usage on visible mount but keeps interval polling inventory-only', async () => {
    jest.useFakeTimers();
    const status = await mountWith({ ...neverRead, refreshedAt: 1 });
    await act(async () => {
      root.render(<LiveProbe />);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(status).toHaveBeenLastCalledWith({
      refresh: true,
      refreshUsage: true,
    });
    await act(async () => {
      jest.advanceTimersByTime(ACCOUNT_PROXY_REFRESH_INTERVAL_MS);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(status).toHaveBeenLastCalledWith({
      refresh: true,
      refreshUsage: false,
    });
  });

  it('joins an in-flight quota refresh without starting another read', async () => {
    const status = await mountWith({ ...neverRead, refreshedAt: 1 });
    let finish: (value: AccountProxyStatus) => void = () => undefined;
    status.mockImplementationOnce(
      () =>
        new Promise<AccountProxyStatus>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      const first = refreshAccountProxyStatus();
      const joined = refreshAccountProxyStatus();
      await Promise.resolve();
      finish({ ...neverRead, refreshedAt: 2 });
      await Promise.all([first, joined]);
    });
    expect(status.mock.calls.slice(1)).toEqual([
      [{ refresh: true, refreshUsage: true }],
    ]);
  });
});
