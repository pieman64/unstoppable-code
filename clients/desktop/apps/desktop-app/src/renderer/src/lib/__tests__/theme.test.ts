/** @jest-environment jsdom */

import {
  applyDisplayPreferences,
  applyScrollbarBehavior,
  applyTheme,
  applyUiScale,
  installUiZoomMetrics,
  resetUiZoomMetricsForTests,
} from '../theme';

function mediaQueryEvent(matches: boolean): MediaQueryListEvent {
  return Object.assign(new Event('change'), {
    matches,
    media: '(prefers-color-scheme: dark)',
  });
}

describe('applyTheme', () => {
  let systemIsDark = false;
  let systemListener: ((event: MediaQueryListEvent) => void) | undefined;
  let removedSystemListener: ((event: MediaQueryListEvent) => void) | undefined;

  beforeEach(() => {
    systemIsDark = false;
    systemListener = undefined;
    removedSystemListener = undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn().mockImplementation(() => ({
        matches: systemIsDark,
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void,
        ): void => {
          systemListener = listener;
        },
        removeEventListener: (
          _type: string,
          listener: (event: MediaQueryListEvent) => void,
        ): void => {
          removedSystemListener = listener;
          if (systemListener === listener) systemListener = undefined;
        },
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      })),
    });
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-sidebar-appearance');
    document.documentElement.removeAttribute('data-scrollbar-behavior');
  });

  afterEach(() => {
    applyTheme('default', 'light');
  });

  function simulateSystemAppearanceChange(isDark: boolean): void {
    systemIsDark = isDark;
    systemListener?.(mediaQueryEvent(isDark));
  }

  it.each([['light', true, false] as const, ['dark', false, true] as const])(
    'keeps explicit %s mode independent of an OS appearance change',
    (colorMode, nextSystemIsDark, expectedDark) => {
      applyTheme('default', colorMode);

      expect(window.matchMedia).not.toHaveBeenCalled();
      simulateSystemAppearanceChange(nextSystemIsDark);

      expect(document.documentElement.classList.contains('dark')).toBe(
        expectedDark,
      );
    },
  );

  it('follows system appearance changes in both directions', () => {
    applyTheme('default', 'system');

    expect(document.documentElement.classList.contains('dark')).toBe(false);

    simulateSystemAppearanceChange(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    simulateSystemAppearanceChange(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('uses the current system appearance when system mode is selected', () => {
    systemIsDark = true;

    applyTheme('default', 'system');

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it.each([['light', false] as const, ['dark', true] as const])(
    'ignores an already queued system appearance event after switching to %s',
    (colorMode, expectedDark) => {
      applyTheme('default', 'system');
      applyTheme('default', colorMode);

      removedSystemListener?.(mediaQueryEvent(!expectedDark));

      expect(document.documentElement.classList.contains('dark')).toBe(
        expectedDark,
      );
    },
  );

  it('applies full chat width and restores the default cap', () => {
    const preferences = {
      theme: 'default' as const,
      colorMode: 'light' as const,
      uiScale: 100,
      chatWidth: 'full' as const,
    };
    applyDisplayPreferences(preferences);
    expect(
      document.documentElement.style.getPropertyValue('--chat-reading-width'),
    ).toBe('100%');
    expect(
      document.documentElement.style.getPropertyValue(
        '--chat-composer-shell-width',
      ),
    ).toBe('100%');
    applyDisplayPreferences({ ...preferences, chatWidth: 'default' });
    expect(
      document.documentElement.style.getPropertyValue('--chat-reading-width'),
    ).toBe('');
    expect(
      document.documentElement.style.getPropertyValue(
        '--chat-composer-shell-width',
      ),
    ).toBe('');
  });

  describe('standard sidebar material', () => {
    function appearance(): string | null {
      return document.documentElement.getAttribute('data-sidebar-appearance');
    }

    it.each(['opaque', 'translucent'] as const)(
      'ignores the retired %s choice in both color modes',
      (saved) => {
        applyDisplayPreferences({
          theme: 'default',
          colorMode: 'light',
          sidebarAppearance: saved,
          uiScale: 100,
        });
        expect(appearance()).toBe('translucent');
        applyDisplayPreferences({
          theme: 'default',
          colorMode: 'dark',
          sidebarAppearance: saved,
          uiScale: 100,
        });
        expect(appearance()).toBe('opaque');
      },
    );

    it('follows the system color mode without an experiment snapshot', () => {
      applyTheme('default', 'system');
      expect(appearance()).toBe('translucent');
      systemListener?.(mediaQueryEvent(true));
      expect(appearance()).toBe('opaque');
    });
  });

  it('defaults missing sidebar appearance preferences to translucent', () => {
    applyDisplayPreferences({
      theme: 'default',
      colorMode: 'light',
      uiScale: 100,
    });

    expect(
      document.documentElement.getAttribute('data-sidebar-appearance'),
    ).toBe('translucent');
  });

  it('applies explicit scrollbar behavior and defaults missing values to System', () => {
    applyScrollbarBehavior('never');
    expect(document.documentElement.dataset.scrollbarBehavior).toBe('never');

    applyDisplayPreferences({
      theme: 'default',
      colorMode: 'light',
      uiScale: 100,
    });
    expect(document.documentElement.dataset.scrollbarBehavior).toBe('system');
  });
});

describe('applyUiScale / installUiZoomMetrics', () => {
  type ChangeListener = (event: MediaQueryListEvent) => void;
  let listenersByQuery: Map<string, ChangeListener[]>;
  let effectiveZoom: number | undefined;
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(
    window,
    'devicePixelRatio',
  );
  const originalMatchMedia = Object.getOwnPropertyDescriptor(
    window,
    'matchMedia',
  );

  function setDevicePixelRatio(value: number): void {
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value,
    });
  }

  function fireDevicePixelRatioChange(previousRatio: number): void {
    const query = `(resolution: ${previousRatio}dppx)`;
    for (const listener of listenersByQuery.get(query) ?? []) {
      listener(
        Object.assign(new Event('change'), { matches: false, media: query }),
      );
    }
  }

  beforeEach(() => {
    listenersByQuery = new Map();
    effectiveZoom = 1;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getUiZoomFactor: (): number | undefined => effectiveZoom,
      },
    });
    setDevicePixelRatio(2);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string): MediaQueryList =>
        Object.assign(new EventTarget(), {
          matches: true,
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: ChangeListener): void => {
            listenersByQuery.set(query, [
              ...(listenersByQuery.get(query) ?? []),
              listener,
            ]);
          },
          removeEventListener: (
            _type: string,
            listener: ChangeListener,
          ): void => {
            listenersByQuery.set(
              query,
              (listenersByQuery.get(query) ?? []).filter(
                (candidate) => candidate !== listener,
              ),
            );
          },
          addListener: jest.fn(),
          removeListener: jest.fn(),
          dispatchEvent: (): boolean => true,
        }),
    });
    resetUiZoomMetricsForTests();
  });

  afterEach(() => {
    resetUiZoomMetricsForTests();
    if (originalApi) Object.defineProperty(window, 'api', originalApi);
    else Reflect.deleteProperty(window, 'api');
    if (originalDevicePixelRatio) {
      Object.defineProperty(
        window,
        'devicePixelRatio',
        originalDevicePixelRatio,
      );
    }
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    }
  });

  function rootStyle(): CSSStyleDeclaration {
    return document.documentElement.style;
  }

  it('records the selected scale and publishes the effective zoom metrics', () => {
    effectiveZoom = 1.5;
    setDevicePixelRatio(3);

    applyUiScale(150);

    expect(document.documentElement.getAttribute('data-ui-scale')).toBe('150');
    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1.5');
    // One device pixel: devicePixelRatio (3 = 2 native x 1.5 zoom) inverted.
    expect(
      Number.parseFloat(rootStyle().getPropertyValue('--border-hairline')) * 3,
    ).toBeCloseTo(1, 10);
  });

  it('keeps the requested scale attribute even while the zoom has not landed yet', () => {
    // The main process applies the zoom asynchronously after the save; the
    // optimistic attribute must not be overwritten by the still-old zoom.
    effectiveZoom = 1;

    applyUiScale(125);

    expect(document.documentElement.getAttribute('data-ui-scale')).toBe('125');
    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1');
  });

  it('syncs the scale attribute from the effective zoom at install time', () => {
    effectiveZoom = 1.25;
    setDevicePixelRatio(2.5);

    installUiZoomMetrics();

    expect(document.documentElement.getAttribute('data-ui-scale')).toBe('125');
    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1.25');
    expect(rootStyle().getPropertyValue('--border-hairline')).toBe(
      `${1 / 2.5}px`,
    );
  });

  it('republishes on every devicePixelRatio change and re-arms the watcher', () => {
    installUiZoomMetrics();
    expect(listenersByQuery.get('(resolution: 2dppx)')).toHaveLength(1);

    // The zoom lands: 2 native x 1.5 = 3.
    effectiveZoom = 1.5;
    setDevicePixelRatio(3);
    fireDevicePixelRatioChange(2);

    expect(document.documentElement.getAttribute('data-ui-scale')).toBe('150');
    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1.5');
    expect(rootStyle().getPropertyValue('--border-hairline')).toBe(
      `${1 / 3}px`,
    );
    expect(listenersByQuery.get('(resolution: 2dppx)')).toHaveLength(0);
    expect(listenersByQuery.get('(resolution: 3dppx)')).toHaveLength(1);

    // Moving to a 1x display at the same zoom: only the hairline changes.
    setDevicePixelRatio(1.5);
    fireDevicePixelRatioChange(3);

    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1.5');
    expect(rootStyle().getPropertyValue('--border-hairline')).toBe(
      `${1 / 1.5}px`,
    );
    expect(listenersByQuery.get('(resolution: 1.5dppx)')).toHaveLength(1);
  });

  it('falls back to zoom 1 when the preload bridge is unavailable', () => {
    Object.defineProperty(window, 'api', { configurable: true, value: {} });

    applyUiScale(150);

    expect(document.documentElement.getAttribute('data-ui-scale')).toBe('150');
    expect(rootStyle().getPropertyValue('--ui-zoom')).toBe('1');
    expect(rootStyle().getPropertyValue('--border-hairline')).toBe('0.5px');
  });
});
