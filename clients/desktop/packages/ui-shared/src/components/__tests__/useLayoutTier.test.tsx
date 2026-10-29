/**
 * @jest-environment jsdom
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LayoutTierProvider } from '../LayoutTierProvider';
import { useIsMobile, useIsPhone, useLayoutTier } from '../useMediaQuery';
import {
  MOBILE_MEDIA_QUERY,
  PHONE_MEDIA_QUERY,
  type LayoutTier,
} from '../../lib/layout-tier';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
  setWidthTier: (tier: LayoutTier) => void;
}

/**
 * Drives the two queries the hook subscribes to from a single named tier, so a
 * test cannot accidentally describe an impossible viewport (phone matching but
 * mobile not).
 */
function createMatchMediaMock(initialTier: LayoutTier): MatchMediaMock {
  const lists = new Map<string, MockMediaQueryList>();

  function matchesFor(tier: LayoutTier, query: string): boolean {
    if (query === PHONE_MEDIA_QUERY) return tier === 'phone';
    if (query === MOBILE_MEDIA_QUERY) return tier !== 'desktop';
    return false;
  }

  let currentTier = initialTier;

  function getOrCreate(query: string): MockMediaQueryList {
    const existing = lists.get(query);
    if (existing) return existing;
    const listeners = new Set<() => void>();
    const list: MockMediaQueryList = {
      matches: matchesFor(currentTier, query),
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
    setWidthTier: (tier): void => {
      currentTier = tier;
      lists.forEach((list) => {
        list.matches = matchesFor(tier, list.media);
      });
      lists.forEach((list) => list.listeners.forEach((listener) => listener()));
    },
  };
}

function renderProbe(
  probe: () => string,
  wrap: (children: ReactNode) => ReactNode = (children): ReactNode => children,
): { container: HTMLDivElement; root: Root } {
  function Probe(): JSX.Element {
    return <span data-testid="value">{probe()}</span>;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(wrap(<Probe />));
  });
  return { container, root };
}

function readValue(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="value"]')?.textContent ?? null;
}

describe('useLayoutTier', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it.each<[LayoutTier]>([['phone'], ['tablet'], ['desktop']])(
    'reports %s from the matching queries',
    (tier) => {
      createMatchMediaMock(tier).install();
      const { container, root } = renderProbe(() => useLayoutTier());
      try {
        expect(readValue(container)).toBe(tier);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  /**
   * SUBSCRIPTION COST MUST NOT SCALE WITH THE TRANSCRIPT.
   *
   * `useIsPhone()` is called once per user message by `UserBubble`, so the
   * naive shape (allocate a `MediaQueryList` inside `subscribe`, call
   * `window.matchMedia(...)` again inside `getSnapshot`) put ~2 native
   * listeners on the document per transcript row and re-allocated on every
   * snapshot read. A long conversation reached four figures, and a single
   * resize fanned out to all of them.
   *
   * The registry collapses that to one list and one native listener per
   * distinct query string, regardless of how many components subscribe. These
   * assertions are the only thing standing between that and a silent
   * reintroduction, since the behaviour is identical either way.
   */
  describe('shared subscription registry', () => {
    it('registers one native listener per query no matter how many consumers', () => {
      const mock = createMatchMediaMock('phone');
      mock.install();

      function ManyConsumers(): JSX.Element {
        return (
          <>
            {Array.from({ length: 25 }, (_unused, index) => (
              <Consumer key={index} />
            ))}
          </>
        );
      }
      function Consumer(): JSX.Element {
        return <span>{useIsPhone() ? 'phone' : 'other'}</span>;
      }

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() => {
        root.render(<ManyConsumers />);
      });

      try {
        mock.lists.forEach((list) => {
          expect(list.listeners.size).toBe(1);
        });
        // Only the two queries the tier hook watches were ever created.
        expect(mock.lists.size).toBe(2);
      } finally {
        act(() => root.unmount());
      }
    });

    it('removes the native listener once the last consumer unmounts', () => {
      const mock = createMatchMediaMock('phone');
      mock.install();
      const { root } = renderProbe(() => useLayoutTier());

      mock.lists.forEach((list) => {
        expect(list.listeners.size).toBe(1);
      });

      act(() => root.unmount());

      mock.lists.forEach((list) => {
        expect(list.listeners.size).toBe(0);
      });
    });

    it('rebuilds against a freshly installed matchMedia rather than a stale cache', () => {
      const first = createMatchMediaMock('desktop');
      first.install();
      const initial = renderProbe(() => useLayoutTier());
      expect(readValue(initial.container)).toBe('desktop');
      act(() => initial.root.unmount());

      // A new mock object entirely — the cache must not answer from the old one.
      const second = createMatchMediaMock('phone');
      second.install();
      const next = renderProbe(() => useLayoutTier());
      try {
        expect(readValue(next.container)).toBe('phone');
      } finally {
        act(() => next.root.unmount());
      }
    });
  });

  it('reacts to a viewport crossing the phone boundary', () => {
    const mock = createMatchMediaMock('desktop');
    mock.install();
    const { container, root } = renderProbe(() => useLayoutTier());

    try {
      expect(readValue(container)).toBe('desktop');
      act(() => mock.setWidthTier('phone'));
      expect(readValue(container)).toBe('phone');
    } finally {
      act(() => root.unmount());
    }
  });

  /**
   * The 1.2b case. `HomeGuestComposer` mounts through
   * `next/dynamic({ ssr: false })` in the marketing tree, where no provider
   * exists — the hook must answer from `matchMedia` rather than throwing or
   * stranding that surface on the desktop treatment.
   */
  it('answers from matchMedia with no provider above it', () => {
    createMatchMediaMock('phone').install();
    const { container, root } = renderProbe(() => useLayoutTier());
    try {
      expect(readValue(container)).toBe('phone');
    } finally {
      act(() => root.unmount());
    }
  });

  /**
   * The seed is for the first paint only. Once `matchMedia` has an answer it
   * wins, because a User Agent knows a device class and not a viewport width.
   */
  it('lets the live viewport override a disagreeing seed', () => {
    createMatchMediaMock('desktop').install();
    const { container, root } = renderProbe(
      () => useLayoutTier(),
      (children) => (
        <LayoutTierProvider tier="phone">{children}</LayoutTierProvider>
      ),
    );
    try {
      expect(readValue(container)).toBe('desktop');
    } finally {
      act(() => root.unmount());
    }
  });

  it('falls back to the seed when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { container, root } = renderProbe(
      () => useLayoutTier(),
      (children) => (
        <LayoutTierProvider tier="phone">{children}</LayoutTierProvider>
      ),
    );
    try {
      expect(readValue(container)).toBe('phone');
    } finally {
      act(() => root.unmount());
    }
  });

  it('falls back to desktop with neither a seed nor matchMedia', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { container, root } = renderProbe(() => useLayoutTier());
    try {
      expect(readValue(container)).toBe('desktop');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('useIsMobile / useIsPhone over the tier', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  /**
   * The whole point of re-expressing `useIsMobile()` on the tier is that no
   * existing call site changes behaviour. A tablet is the case that would
   * regress if the boundary moved to 640px by mistake.
   */
  it.each<[LayoutTier, string, string]>([
    ['phone', 'true', 'true'],
    ['tablet', 'true', 'false'],
    ['desktop', 'false', 'false'],
  ])('at %s: isMobile=%s isPhone=%s', (tier, expectedMobile, expectedPhone) => {
    createMatchMediaMock(tier).install();
    const mobile = renderProbe(() => String(useIsMobile()));
    const phone = renderProbe(() => String(useIsPhone()));
    try {
      expect(readValue(mobile.container)).toBe(expectedMobile);
      expect(readValue(phone.container)).toBe(expectedPhone);
    } finally {
      act(() => mobile.root.unmount());
      act(() => phone.root.unmount());
    }
  });
});
