/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useMarketplaceOAuth } from '../useMarketplaceOAuth';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('marketplace OAuth', () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: ReturnType<typeof useMarketplaceOAuth>;
  const startOAuthLogin = jest.fn();
  const cancelOAuthLogin = jest.fn().mockResolvedValue(undefined);
  const original = window.mcpServers;
  const request = { serverId: 'service', configId: 'default' };
  function Host(): null {
    state = useMarketplaceOAuth();
    return null;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    startOAuthLogin.mockReset();
    cancelOAuthLogin.mockClear();
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { startOAuthLogin, cancelOAuthLogin },
    });
    container = document.createElement('div');
    root = createRoot(container);
    act(() => root.render(<Host />));
  });
  afterEach(() => {
    act(() => root.unmount());
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: original,
    });
    jest.useRealTimers();
  });

  it('opens one embedded sign-in for repeated clicks and clears it on completion', async () => {
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://service.test/authorize',
    });
    await act(async () => {
      await Promise.all([state.start(request), state.start(request)]);
    });
    expect(startOAuthLogin).toHaveBeenCalledTimes(1);
    expect(startOAuthLogin).toHaveBeenCalledWith({
      ...request,
      browser: 'embedded',
    });
    expect(state.pending).toBe(true);
    expect(state.url).toBe('https://service.test/authorize');
    act(() => state.finish());
    expect(state.pending).toBe(false);
    expect(state.url).toBeNull();
  });

  it('shows a retryable error when discovery fails, then accepts an already connected response', async () => {
    startOAuthLogin
      .mockRejectedValueOnce(new Error('Service unavailable'))
      .mockResolvedValueOnce({ status: 'completed' });
    await act(async () => state.start(request));
    expect(state.error).toBe('Service unavailable');
    expect(state.pending).toBe(false);
    await act(async () => state.start(request));
    expect(state.error).toBeNull();
    expect(state.url).toBeNull();
  });

  it('lets users retry after closing or abandoning sign-in', async () => {
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      authorizationUrl: 'https://service.test/authorize',
    });
    await act(async () => state.start(request));
    act(() => state.closeBrowser());
    expect(state.pending).toBe(false);
    await act(async () => state.start(request));
    act(() => jest.advanceTimersByTime(120_000));
    expect(state.error).toContain('Connect again');
    expect(state.pending).toBe(false);
    expect(state.url).toBeNull();
  });
  it('cancels a closed sign-in in the main process', async () => {
    startOAuthLogin.mockResolvedValue({
      status: 'started',
      flowId: 'attempt-1',
      authorizationUrl: 'https://service.test/authorize',
    });
    await act(async () => state.start(request));
    act(() => state.closeBrowser());
    expect(cancelOAuthLogin).toHaveBeenCalledWith('attempt-1');
  });
});
