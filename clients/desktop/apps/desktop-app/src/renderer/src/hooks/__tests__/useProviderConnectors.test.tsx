/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useProviderConnectors } from '../useProviderConnectors';

const REAL_START_MS = Date.now();
let clockOffsetMs = 0;
let container: HTMLDivElement;
let root: Root;
let listProviderConnectors: jest.Mock;
let probe: ReturnType<typeof useProviderConnectors>;

function Harness(): null {
  probe = useProviderConnectors();
  return null;
}

function mount(): void {
  act(() => {
    root.render(<Harness />);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  // The hook caches results module-wide for a short TTL so a remounted picker
  // does not re-spawn the CLI. That state outlives a test, so each one runs at
  // a later wall-clock time than the last — cumulative, because setting the
  // same offset every time would put a previous test's entry at age zero and
  // hand it straight back.
  clockOffsetMs += 10 * 60_000;
  jest.setSystemTime(REAL_START_MS + clockOffsetMs);
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

describe('useProviderConnectors', () => {
  it('reads once on mount', async () => {
    mount();
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);
  });

  it('reports loading so callers can explain the wait', async () => {
    // The read spawns a CLI that health-checks every server and takes
    // seconds; silence there reads as "the button did not work".
    let resolveRead: (value: []) => void = () => undefined;
    listProviderConnectors.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveRead = resolve;
      }),
    );
    mount();
    expect(probe.loading).toBe(true);

    await act(async () => {
      resolveRead([]);
      await Promise.resolve();
    });
    expect(probe.loading).toBe(false);
  });

  it('re-reads when the user returns from the provider site', async () => {
    mount();
    await flush();

    act(() => {
      jest.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(2);
  });

  it('does not re-read on every alt-tab', async () => {
    // Each focus otherwise pays the multi-second CLI cost again.
    mount();
    await flush();

    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);
  });

  it('always honors an explicit refresh', async () => {
    // The user asking is a better signal than the interval guard, and it is
    // the escape hatch when a focus read landed before linking finished.
    mount();
    await flush();

    act(() => probe.refresh());
    await flush();
    expect(listProviderConnectors).toHaveBeenCalledTimes(2);
  });

  it('does not run overlapping reads', async () => {
    let resolveRead: (value: []) => void = () => undefined;
    listProviderConnectors.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveRead = resolve;
      }),
    );
    mount();

    act(() => probe.refresh());
    act(() => probe.refresh());
    expect(listProviderConnectors).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRead([]);
      await Promise.resolve();
    });
  });

  it('keeps the previous list when a read fails', async () => {
    listProviderConnectors.mockResolvedValue([
      { provider: 'claude', connectors: [] },
    ]);
    mount();
    await flush();
    expect(probe.results).toHaveLength(1);

    listProviderConnectors.mockRejectedValue(new Error('cli gone'));
    act(() => probe.refresh());
    await flush();
    expect(probe.results).toHaveLength(1);
    expect(probe.loading).toBe(false);
  });
});

describe('the not-yet-read state is in the data, not inferred', () => {
  it('reports results as undefined before the first read settles', () => {
    // Callers previously had to reconstruct "not attempted yet" from
    // `loading && results.length === 0`, and got it wrong: `loading` starts
    // false, so the very first render read as "answered: nothing linked" —
    // the same false negative this feature keeps reintroducing. Representing
    // it in the data makes that reconstruction impossible.
    const seen: Array<readonly unknown[] | undefined> = [];
    function Probe(): null {
      const { results } = useProviderConnectors();
      seen.push(results);
      return null;
    }
    act(() => {
      createRoot(container).render(<Probe />);
    });
    expect(seen[0]).toBeUndefined();
  });
});

describe('an explicit refresh is never silently dropped', () => {
  it('re-reads after the in-flight read settles', async () => {
    // Open the panel and hit Re-check inside the first second, while the mount
    // read is still running. The in-flight guard swallowed that click and the
    // stale answer stood until the next focus or remount — the user asks to
    // check again and nothing happens.
    let settle: (value: unknown) => void = () => undefined;
    listProviderConnectors.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    listProviderConnectors.mockResolvedValue([
      {
        provider: 'claude',
        connectors: [
          {
            name: 'claude.ai Gmail',
            displayName: 'Gmail',
            connected: true,
            status: '✔ Connected',
          },
        ],
      },
    ]);

    mount();
    act(() => probe.refresh());
    settle([{ provider: 'claude', connectors: [] }]);
    await flush();
    await flush();

    expect(listProviderConnectors.mock.calls.length).toBeGreaterThan(1);
    expect(probe.results?.[0]?.connectors[0]?.connected).toBe(true);
  });
});
