/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useIsMobile, useMediaQuery } from '../useMediaQuery';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The hook subscribes with useSyncExternalStore's zero-arg onStoreChange, so
// the mock's listeners take no event and no MediaQueryListEvent needs to be
// constructed when notifying them.
interface MockMediaQueryList {
  matches: boolean;
  media: string;
  readonly listeners: Set<() => void>;
  addEventListener: (type: 'change', listener: () => void) => void;
  removeEventListener: (type: 'change', listener: () => void) => void;
}

interface MatchMediaMock {
  install: () => void;
  lists: Map<string, MockMediaQueryList>;
  setMatches: (query: string, matches: boolean) => void;
}

function createMatchMediaMock(
  initialMatches: (query: string) => boolean,
): MatchMediaMock {
  const lists = new Map<string, MockMediaQueryList>();

  function getOrCreate(query: string): MockMediaQueryList {
    const existing = lists.get(query);
    if (existing) return existing;
    const listeners = new Set<() => void>();
    const list: MockMediaQueryList = {
      matches: initialMatches(query),
      media: query,
      listeners,
      addEventListener: (_type, listener): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener): void => {
        listeners.delete(listener);
      },
    };
    lists.set(query, list);
    return list;
  }

  return {
    lists,
    install: (): void => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string): MockMediaQueryList => getOrCreate(query),
      });
    },
    setMatches: (query, matches): void => {
      const list = getOrCreate(query);
      list.matches = matches;
      list.listeners.forEach((listener) => listener());
    },
  };
}

function renderHookValue(hook: () => boolean): {
  container: HTMLDivElement;
  root: Root;
} {
  function Probe(): JSX.Element {
    const value = hook();
    return <span data-testid="value">{String(value)}</span>;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Probe />);
  });
  return { container, root };
}

function readValue(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="value"]')?.textContent ?? null;
}

describe('useMediaQuery', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('reflects the initial match state', () => {
    const mock = createMatchMediaMock(() => true);
    mock.install();
    const { container, root } = renderHookValue(() =>
      useMediaQuery('(max-width: 1023px)'),
    );

    try {
      expect(readValue(container)).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('updates when the media query changes', () => {
    const mock = createMatchMediaMock(() => false);
    mock.install();
    const query = '(max-width: 1023px)';
    const { container, root } = renderHookValue(() => useMediaQuery(query));

    try {
      expect(readValue(container)).toBe('false');
      act(() => {
        mock.setMatches(query, true);
      });
      expect(readValue(container)).toBe('true');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it('removes its change listener on unmount', () => {
    const mock = createMatchMediaMock(() => true);
    mock.install();
    const query = '(max-width: 1023px)';
    const { root } = renderHookValue(() => useMediaQuery(query));

    act(() => {
      root.unmount();
    });

    expect(mock.lists.get(query)?.listeners.size).toBe(0);
  });

  it('returns false when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { container, root } = renderHookValue(() =>
      useMediaQuery('(max-width: 1023px)'),
    );

    try {
      expect(readValue(container)).toBe('false');
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});

describe('useIsMobile', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('queries the below-lg breakpoint (max-width: 1023px)', () => {
    const mock = createMatchMediaMock(
      (query) => query === '(max-width: 1023px)',
    );
    mock.install();
    const { container, root } = renderHookValue(() => useIsMobile());

    try {
      expect(readValue(container)).toBe('true');
      expect(mock.lists.has('(max-width: 1023px)')).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
