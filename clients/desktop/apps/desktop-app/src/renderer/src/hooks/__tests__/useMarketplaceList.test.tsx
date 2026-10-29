/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import {
  useMarketplaceList,
  applyCodexCompatDisabledToMarketplaceCaches,
  applyPluginUpdateToMarketplaceCaches,
} from '../useMarketplaceList';

function makePlugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'My-Plugin',
    sourcePath: 'plugins/my-plugin',
    marketplaceId: 'mkt-1',
    providerSupport: { claude: 'native', codex: 'compat' },
    facets: {},
    codexCompatDisabled: false,
    ...overrides,
  };
}

function makeMarketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'mkt-1',
    name: 'Acme Plugins',
    sourceType: 'github',
    sourceUrl: 'acme/plugins',
    installLocation: '/tmp/mkt',
    pluginCount: 1,
    plugins: [makePlugin()],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: 1,
        lastCheckedAt: '2026-05-01T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

function makeCache(): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-05-01T00:00:00.000Z',
    marketplaces: [makeMarketplace()],
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  const deferred: { resolve?: (value: T) => void } = {};
  const promise = new Promise<T>((resolve) => {
    deferred.resolve = resolve;
  });
  if (!deferred.resolve) throw new Error('Deferred resolver was not created');
  return { promise, resolve: deferred.resolve };
}

interface HookProbe {
  current: ReturnType<typeof useMarketplaceList> | null;
}

/**
 * Tiny render harness that surfaces the hook's return value into a probe ref
 * since this repo does not depend on @testing-library/react's renderHook.
 */
function HookHarness({
  probe,
  enabled,
}: {
  probe: HookProbe;
  enabled?: boolean;
}): null {
  probe.current = useMarketplaceList(enabled === undefined ? {} : { enabled });
  return null;
}

function findPlugin(
  result: ReturnType<typeof useMarketplaceList> | null,
  marketplaceId: string,
  pluginName: string,
): PluginInfo | undefined {
  return result?.cache?.marketplaces
    .find((m) => m.id === marketplaceId)
    ?.plugins.find((p) => p.name === pluginName);
}

describe('applyCodexCompatDisabledToMarketplaceCaches', () => {
  let containerA: HTMLDivElement;
  let containerB: HTMLDivElement;
  let rootA: Root;
  let rootB: Root;
  let originalPlugins: Window['plugins'] | undefined;
  let loadMarketplacesMock: jest.Mock;

  beforeEach(() => {
    originalPlugins = window.plugins;
    loadMarketplacesMock = jest
      .fn()
      .mockResolvedValue({ success: true, data: makeCache() });
    const pluginsApi = {
      loadMarketplaces: loadMarketplacesMock,
      onMarketplaceOperationProgress: jest
        .fn()
        .mockReturnValue(() => undefined),
    };
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: pluginsApi,
    });

    containerA = document.createElement('div');
    containerB = document.createElement('div');
    document.body.appendChild(containerA);
    document.body.appendChild(containerB);
    rootA = createRoot(containerA);
    rootB = createRoot(containerB);
  });

  afterEach(() => {
    act(() => {
      rootA.unmount();
      rootB.unmount();
    });
    containerA.remove();
    containerB.remove();
    if (originalPlugins === undefined) {
      Reflect.deleteProperty(window, 'plugins');
    } else {
      Object.defineProperty(window, 'plugins', {
        configurable: true,
        value: originalPlugins,
      });
    }
  });

  it('defers the catalog load until enabled and loads it once', async () => {
    const probe: HookProbe = { current: null };
    const loadMarketplaces = loadMarketplacesMock;

    await act(async () => {
      rootA.render(<HookHarness probe={probe} enabled={false} />);
      await Promise.resolve();
    });
    // Mounted but disabled: nothing is fetched (the composer is mounted on
    // every surface; its Add menu is not).
    expect(loadMarketplaces).not.toHaveBeenCalled();
    expect(probe.current?.cache).toBeNull();

    await act(async () => {
      rootA.render(<HookHarness probe={probe} enabled />);
      await Promise.resolve();
    });
    expect(loadMarketplaces).toHaveBeenCalledTimes(1);
    expect(probe.current?.cache?.marketplaces.length).toBeGreaterThan(0);

    // Flipping back and forth (menu closed, reopened) does not refetch: the
    // hook keeps the loaded catalog.
    await act(async () => {
      rootA.render(<HookHarness probe={probe} enabled={false} />);
      await Promise.resolve();
    });
    await act(async () => {
      rootA.render(<HookHarness probe={probe} enabled />);
      await Promise.resolve();
    });
    expect(loadMarketplaces).toHaveBeenCalledTimes(1);
    expect(probe.current?.cache?.marketplaces.length).toBeGreaterThan(0);
  });

  it('patches codexCompatDisabled across all mounted hook instances', async () => {
    const probeA: HookProbe = { current: null };
    const probeB: HookProbe = { current: null };

    await act(async () => {
      rootA.render(<HookHarness probe={probeA} />);
      rootB.render(<HookHarness probe={probeB} />);
      // Flush the async loadMarketplaces() effect so the initial cache lands.
      await Promise.resolve();
    });

    // Both instances loaded the initial cache with compat enabled.
    expect(
      findPlugin(probeA.current, 'mkt-1', 'My-Plugin')?.codexCompatDisabled,
    ).toBe(false);
    expect(
      findPlugin(probeB.current, 'mkt-1', 'My-Plugin')?.codexCompatDisabled,
    ).toBe(false);

    act(() => {
      applyCodexCompatDisabledToMarketplaceCaches('mkt-1', 'My-Plugin', true);
    });

    // The patch propagated to every mounted instance.
    expect(
      findPlugin(probeA.current, 'mkt-1', 'My-Plugin')?.codexCompatDisabled,
    ).toBe(true);
    expect(
      findPlugin(probeB.current, 'mkt-1', 'My-Plugin')?.codexCompatDisabled,
    ).toBe(true);
  });

  it('matches plugin updates by marketplace row name when manifest name differs', async () => {
    const probeA: HookProbe = { current: null };
    const probeB: HookProbe = { current: null };

    await act(async () => {
      rootA.render(<HookHarness probe={probeA} />);
      rootB.render(<HookHarness probe={probeB} />);
      await Promise.resolve();
    });

    const renamed = makePlugin({
      name: 'Manifest-Plugin',
      codexCompatDisabled: true,
    });

    act(() => {
      applyPluginUpdateToMarketplaceCaches('mkt-1', 'My-Plugin', renamed);
    });

    expect(findPlugin(probeA.current, 'mkt-1', 'My-Plugin')).toBeUndefined();
    expect(
      findPlugin(probeA.current, 'mkt-1', 'Manifest-Plugin'),
    ).toMatchObject({
      name: 'Manifest-Plugin',
      codexCompatDisabled: true,
    });
    expect(findPlugin(probeB.current, 'mkt-1', 'My-Plugin')).toBeUndefined();
    expect(
      findPlugin(probeB.current, 'mkt-1', 'Manifest-Plugin'),
    ).toMatchObject({
      name: 'Manifest-Plugin',
      codexCompatDisabled: true,
    });
  });

  it('does not let a stale reload overwrite a later plugin install update', async () => {
    const probe: HookProbe = { current: null };
    await act(async () => {
      rootA.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });

    const staleReload = createDeferred<{
      success: true;
      data: PluginsCache;
    }>();
    loadMarketplacesMock.mockReturnValueOnce(staleReload.promise);
    let reloadPromise: Promise<void> | undefined;
    await act(async () => {
      reloadPromise = probe.current?.reload();
      await Promise.resolve();
    });

    act(() => {
      applyPluginUpdateToMarketplaceCaches(
        'mkt-1',
        'My-Plugin',
        makePlugin({ sourcePath: 'plugins/installed-my-plugin' }),
      );
    });
    expect(findPlugin(probe.current, 'mkt-1', 'My-Plugin')?.sourcePath).toBe(
      'plugins/installed-my-plugin',
    );

    await act(async () => {
      staleReload.resolve({ success: true, data: makeCache() });
      await reloadPromise;
    });

    expect(findPlugin(probe.current, 'mkt-1', 'My-Plugin')?.sourcePath).toBe(
      'plugins/installed-my-plugin',
    );
    expect(probe.current?.loading).toBe(false);
  });
});
