/**
 * @jest-environment jsdom
 *
 * Its own file on purpose. `useProviderConnectors` keeps its cache and its
 * in-flight promise at module scope, and Jest isolates modules per file, not
 * per test — so a neighbouring test that leaves `inFlightRead` set makes a
 * later mount join that promise instead of taking the cache branch. This
 * assertion is specifically about the cache branch, so it needs a clean module.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProviderConnectors } from '../useProviderConnectors';

const START_MS = Date.now();
let container: HTMLDivElement;
let root: Root;
let listProviderConnectors: jest.Mock;

function Harness(): null {
  useProviderConnectors();
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(START_MS);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listProviderConnectors = jest.fn().mockResolvedValue([]);
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { listProviderConnectors },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
});

describe('a cache-served mount inherits the cached entry age', () => {
  it('does not let the next focus bypass the read throttle', async () => {
    // The other suite advances the clock past the TTL before every test, so
    // the cache-serve branch had never executed under test at all. Mount,
    // remount inside the TTL so the second mount is served from cache, then
    // focus. A cache-served mount that reported "never read" would treat the
    // focus throttle as already satisfied and pay the CLI spawn — which
    // health-checks every configured MCP server — that the cache exists to
    // avoid on exactly this remount path.
    act(() => root.render(<Harness />));
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    jest.setSystemTime(START_MS + 1_000); // inside RESULT_CACHE_TTL_MS
    root = createRoot(container);
    act(() => root.render(<Harness />));
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);

    // Inside FOCUS_REFRESH_MIN_INTERVAL_MS of the cached entry's own read.
    jest.setSystemTime(START_MS + 2_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);
  });
});

describe('a clock that moved backwards', () => {
  it('does not pin a cache entry as permanently fresh', async () => {
    // Age is `now - at`. If the system clock moves back — a time sync, a
    // suspend/resume — the entry's age goes negative, and a plain
    // `age < TTL` check reads that as fresh forever: it only gets more
    // negative from there, so the read never goes to the provider again.
    // Past the TTL of the entry the previous test left behind — the cache is
    // module-scoped and Jest isolates modules per file, not per test.
    jest.setSystemTime(START_MS + 10 * 60_000);
    act(() => root.render(<Harness />));
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    jest.setSystemTime(START_MS - 60 * 60_000); // an hour into the past
    root = createRoot(container);
    act(() => root.render(<Harness />));
    await flush();

    expect(listProviderConnectors).toHaveBeenCalledTimes(2);
  });
});
