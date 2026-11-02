/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { focusViaKeyboard } from '@/test-utils/dom';
import type { WakeLockState } from '@canopy/desktop-shared/types';
import { useNavigationStore } from '@/stores/navigationStore';
import { resetExperimentalFeaturesStoreForTest } from '@/stores/experimentalFeaturesStore';
import { WakeLockIndicator } from '../WakeLockIndicator';

interface MockWakeLockApi {
  getWakeLockState: jest.Mock<Promise<WakeLockState>, []>;
  onWakeLockStateChanged: jest.Mock<
    () => void,
    [(state: WakeLockState) => void]
  >;
}

function installWindowApi(api: MockWakeLockApi): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

function createApi(initial: WakeLockState): MockWakeLockApi {
  return {
    getWakeLockState: jest.fn(() => Promise.resolve(initial)),
    onWakeLockStateChanged: jest.fn<
      () => void,
      [(state: WakeLockState) => void]
    >((): (() => void) => () => {}),
  };
}

async function renderIndicator(
  api: MockWakeLockApi,
  {
    collapsed = false,
    statusBar = false,
    platform = 'darwin',
  }: {
    collapsed?: boolean;
    statusBar?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): Promise<{ container: HTMLElement; root: Root }> {
  installWindowApi(api);
  setPlatform(platform);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WakeLockIndicator collapsed={collapsed} statusBar={statusBar} />,
    );
    await Promise.resolve();
  });
  return { container, root };
}

describe('WakeLockIndicator', () => {
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'platform',
    );
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    // The pill shows only while early access is off; most cases exercise
    // it there.
    setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
  });

  afterEach(() => {
    resetExperimentalFeaturesStoreForTest();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
    if (originalActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        'IS_REACT_ACT_ENVIRONMENT',
        originalActEnvironmentDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  });

  it('loads initial state and renders only while active', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api);

    expect(api.getWakeLockState).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('stays hidden and does not subscribe while early access is on', async () => {
    act(() => {
      setTestEarlyAccessFeatures({ enabled: true, hydrated: true });
    });
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api, { statusBar: true });

    expect(
      container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
    ).toBeNull();
    expect(api.getWakeLockState).not.toHaveBeenCalled();
    expect(api.onWakeLockStateChanged).not.toHaveBeenCalled();

    act(() => {
      setTestEarlyAccessFeatures({ enabled: false, hydrated: true });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
    ).not.toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders on Windows with Windows-specific aria-label text', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api, {
      platform: 'win32',
    });

    const indicator = container.querySelector(
      '[data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('aria-label')).toContain('Your PC can lock');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('shows Linux activity and hides again on idle', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api, {
      platform: 'linux',
      statusBar: true,
    });
    try {
      const indicator = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-wake-lock-indicator"]',
      );
      expect(api.getWakeLockState).toHaveBeenCalledTimes(1);
      expect(api.onWakeLockStateChanged).toHaveBeenCalledTimes(1);
      expect(indicator?.getAttribute('aria-label')).toContain(
        'Your device can lock',
      );
      expect(indicator?.textContent).toContain('Sleep paused');
      const callback = api.onWakeLockStateChanged.mock.calls[0][0];
      act(() => callback({ active: false, enabled: true, holderCount: 0 }));
      expect(
        container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('does not subscribe on unsupported platforms', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api, {
      platform: 'freebsd',
    });

    expect(api.getWakeLockState).not.toHaveBeenCalled();
    expect(api.onWakeLockStateChanged).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('hides when disabled even with holders', async () => {
    const api = createApi({ active: false, enabled: false, holderCount: 2 });
    const { container, root } = await renderIndicator(api);

    expect(
      container.querySelector('[data-testid="sidebar-wake-lock-indicator"]'),
    ).toBeNull();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('unsubscribes on unmount', async () => {
    const unsubscribe = jest.fn();
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    api.onWakeLockStateChanged.mockReturnValueOnce(unsubscribe);
    const { container, root } = await renderIndicator(api);

    act(() => {
      root.unmount();
    });
    container.remove();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('shows the shared tooltip with the full aria-label on focus', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api, { collapsed: true });

    // The shared Tooltip portals its content into document.body and is not
    // mounted until the trigger is hovered/focused.
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(button).not.toBeNull();
    expect(button?.className).toContain('h-8');
    expect(button?.className).toContain('gap-2');
    expect(button?.className).toContain('text-s');
    expect(button?.className).toContain('rounded-row');
    expect(button?.className).not.toContain('bg-amber');
    expect(button?.className).toContain('hover:bg-subtle');

    act(() => {
      focusViaKeyboard(button);
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('Sleep paused');
    expect(tooltip?.textContent).toContain('lock and turn off the display');
    // The shared tooltip begins its fade-out on blur (it keeps the portal
    // mounted briefly for the exit transition).
    act(() => {
      button?.blur();
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders a labeled status pill in statusBar mode regardless of collapsed', async () => {
    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    // AppSidebar historically mounted the status-bar variant with
    // `collapsed` forced on, which hid the label and left a bare glyph
    // floating under the composer. The pill must always carry its label.
    const { container, root } = await renderIndicator(api, {
      collapsed: true,
      statusBar: true,
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(button).not.toBeNull();
    expect(button?.className).toContain('rounded-full');
    expect(button?.className).toContain('bg-quaternary');
    expect(button?.className).toContain('shadow-sm');
    // The house hairline ring keeps the chip legible as a raised surface over
    // arbitrary panel content in dark mode, where the shadow alone vanishes.
    expect(button?.className).toContain('ring-[length:var(--border-hairline)]');
    expect(button?.className).toContain('ring-line-secondary');
    // The whole chip responds to hover: the surface lifts and the glyph
    // follows the label to the primary ink.
    expect(button?.className).toContain(
      'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
    );
    expect(
      button
        ?.querySelector('span')
        ?.className.includes('group-hover:fg-primary'),
    ).toBe(true);

    const label = Array.from(button?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'Sleep paused',
    );
    expect(label).toBeDefined();
    expect(label?.className).not.toContain('w-0');
    expect(label?.className).not.toContain('opacity-0');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('opens performance settings on click', async () => {
    const initialOpenSettings = useNavigationStore.getState().openSettings;
    const openSettings = jest.fn();
    act(() => {
      useNavigationStore.setState({ openSettings });
    });

    const api = createApi({ active: true, enabled: true, holderCount: 1 });
    const { container, root } = await renderIndicator(api);

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(button).not.toBeNull();

    act(() => {
      button?.click();
    });
    expect(openSettings).toHaveBeenCalledWith('performance');

    act(() => {
      root.unmount();
    });
    container.remove();
    act(() => {
      useNavigationStore.setState({ openSettings: initialOpenSettings });
    });
  });

  it('keeps a subscription event that arrives before initial fetch resolves', async () => {
    let resolveInitial!: (state: WakeLockState) => void;
    const api: MockWakeLockApi = {
      getWakeLockState: jest.fn(
        () =>
          new Promise<WakeLockState>((resolve) => {
            resolveInitial = resolve;
          }),
      ),
      onWakeLockStateChanged: jest.fn((callback) => {
        callback({ active: true, enabled: true, holderCount: 2 });
        return jest.fn();
      }),
    };
    const { container, root } = await renderIndicator(api);

    await act(async () => {
      resolveInitial({ active: false, enabled: true, holderCount: 0 });
      await Promise.resolve();
    });

    const indicator = container.querySelector(
      '[data-testid="sidebar-wake-lock-indicator"]',
    );
    expect(indicator?.getAttribute('aria-label')).toContain('2 active agents');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
