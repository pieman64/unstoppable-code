/**
 * @jest-environment jsdom
 *
 * Single-flight and invalidation behavior of the plugin-provider-support
 * loader.
 *
 * The cross-harness continue flow gives up on its own timeout and then tells
 * the user to try again, which only works if abandoning a request actually
 * retires it. These tests pin the two halves of that: a retry must issue a
 * fresh request, and the abandoned request must become inert rather than
 * settling later into live state.
 */
import type { PluginsCache } from '@canopy/desktop-shared/types/plugins';

interface LoaderModule {
  loadPluginProviderSupportIndex: () => Promise<Map<
    string,
    { claude: string; codex: string }
  > | null>;
  invalidatePluginProviderSupportIndexLoad: (
    expectedGeneration?: number,
  ) => void;
  getPluginProviderSupportLoadGeneration: () => number;
  getCachedPluginProviderSupportIndex: () => Map<
    string,
    { claude: string; codex: string }
  > | null;
  pluginProviderSupportKey: (
    marketplaceId: string,
    pluginName: string,
  ) => string;
}

function buildCache(pluginNames: string[]): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-03-19T00:00:00.000Z',
    marketplaces: [
      {
        id: 'agent-plugins',
        name: 'Agent Plugins',
        sourceType: 'github',
        sourceUrl: 'https://github.com/example/agent-plugins',
        installLocation: '/tmp/agent-plugins',
        pluginCount: pluginNames.length,
        validProviders: ['claude', 'codex'],
        providerStatus: {},
        plugins: pluginNames.map((name) => ({
          name,
          sourcePath: `/tmp/agent-plugins/${name}`,
          marketplaceId: 'agent-plugins',
          providerSupport: { claude: 'native', codex: 'native' },
          facets: {},
        })),
      },
    ],
  };
}

describe('loadPluginProviderSupportIndex invalidation', () => {
  let loadMarketplaces: jest.Mock;
  let loader: LoaderModule;

  beforeEach(() => {
    jest.resetModules();
    // Default to a never-settling call rather than `undefined`, so an
    // unexpected extra request fails an assertion instead of crashing the
    // loader on `undefined.then` and obscuring which behavior broke.
    loadMarketplaces = jest.fn(() => new Promise(() => {}));
    Object.defineProperty(window, 'plugins', {
      value: { loadMarketplaces },
      configurable: true,
      writable: true,
    });
    loader = jest.requireActual('../plugin-provider-support');
  });

  it('hands a retry a fresh request instead of the abandoned promise', async () => {
    // The memo is cleared only in the promise's own `finally`, so without
    // explicit invalidation a hung request is handed to every later caller and
    // the "try again" the continue flow promises can never succeed.
    loadMarketplaces.mockImplementationOnce(() => new Promise(() => {}));
    const abandoned = loader.loadPluginProviderSupportIndex();
    expect(loadMarketplaces).toHaveBeenCalledTimes(1);

    loader.invalidatePluginProviderSupportIndexLoad();

    loadMarketplaces.mockResolvedValueOnce({
      success: true,
      data: buildCache(['shared']),
    });
    const retry = await loader.loadPluginProviderSupportIndex();

    expect(loadMarketplaces).toHaveBeenCalledTimes(2);
    expect(
      retry?.has(loader.pluginProviderSupportKey('agent-plugins', 'shared')),
    ).toBe(true);
    // Silence the never-settling promise for the runner.
    void abandoned;
  });

  it('does not let an abandoned load publish over a newer index', async () => {
    // The abandoned request still settles eventually. If it writes its own
    // (older) snapshot into the cache at that point, a later compatibility
    // decision is made against a catalog that has since changed.
    let settleFirst: (value: {
      success: boolean;
      data: PluginsCache;
    }) => void = () => {};
    loadMarketplaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const abandoned = loader.loadPluginProviderSupportIndex();

    loader.invalidatePluginProviderSupportIndexLoad();

    loadMarketplaces.mockResolvedValueOnce({
      success: true,
      data: buildCache(['current']),
    });
    await loader.loadPluginProviderSupportIndex();

    // The retired request now returns the catalog as it looked before.
    settleFirst({ success: true, data: buildCache(['stale']) });
    await abandoned;

    const cached = loader.getCachedPluginProviderSupportIndex();
    expect(
      cached?.has(loader.pluginProviderSupportKey('agent-plugins', 'current')),
    ).toBe(true);
    expect(
      cached?.has(loader.pluginProviderSupportKey('agent-plugins', 'stale')),
    ).toBe(false);
  });

  it('resolves a retired load to null rather than its superseded index', async () => {
    // A caller already awaiting the shared promise when it was retired would
    // otherwise receive a snapshot a newer load has since superseded, silently
    // bypassing the fresher cache. Reachable with concurrent continues: one
    // times out and invalidates while another is still inside its own timeout.
    let settleFirst: (value: {
      success: boolean;
      data: PluginsCache;
    }) => void = () => {};
    loadMarketplaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const stillWaiting = loader.loadPluginProviderSupportIndex();

    loader.invalidatePluginProviderSupportIndexLoad();

    loadMarketplaces.mockResolvedValueOnce({
      success: true,
      data: buildCache(['current']),
    });
    await loader.loadPluginProviderSupportIndex();

    settleFirst({ success: true, data: buildCache(['superseded']) });

    // The still-waiting caller gets `null`, not the retired index, so its own
    // policy (bounded cache, or a fail-closed refusal) decides what happens.
    await expect(stillWaiting).resolves.toBeNull();
  });

  it('does not let an abandoned load evict a newer in-flight request', async () => {
    // The abandoned request's `finally` runs after a newer one has memoized
    // itself. Clearing unconditionally there costs the single-flight dedup this
    // module exists to provide.
    let settleFirst: (value: { success: boolean }) => void = () => {};
    loadMarketplaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleFirst = resolve;
        }),
    );
    const abandoned = loader.loadPluginProviderSupportIndex();

    loader.invalidatePluginProviderSupportIndexLoad();

    let settleSecond: (value: {
      success: boolean;
      data: PluginsCache;
    }) => void = () => {};
    loadMarketplaces.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleSecond = resolve;
        }),
    );
    const inFlight = loader.loadPluginProviderSupportIndex();
    expect(loadMarketplaces).toHaveBeenCalledTimes(2);

    // Retire the first request AFTER the second memoized itself.
    settleFirst({ success: false });
    await abandoned;

    // A third caller must join the in-flight second request, not start another.
    void loader.loadPluginProviderSupportIndex();
    expect(loadMarketplaces).toHaveBeenCalledTimes(2);

    settleSecond({ success: true, data: buildCache(['shared']) });
    await inFlight;
  });

  it('does not let an older waiter retire a newer retry load', async () => {
    // Two staggered continues share load A. The first times out, retires A and
    // starts retry B. The second then times out on its own later deadline —
    // and must NOT retire B, or the retry the failure message promises fails
    // even though its marketplace call succeeded.
    const genA = loader.getPluginProviderSupportLoadGeneration();
    loadMarketplaces.mockImplementationOnce(() => new Promise(() => {}));
    const sharedA = loader.loadPluginProviderSupportIndex();
    // The second caller joins the SAME load, so it captured the same generation.
    const genB = loader.getPluginProviderSupportLoadGeneration();
    void loader.loadPluginProviderSupportIndex();
    expect(genA).toBe(genB);
    expect(loadMarketplaces).toHaveBeenCalledTimes(1);

    // First caller times out and retries.
    loader.invalidatePluginProviderSupportIndexLoad(genA);
    loadMarketplaces.mockResolvedValueOnce({
      success: true,
      data: buildCache(['retry']),
    });
    const retry = loader.loadPluginProviderSupportIndex();

    // Second caller times out LATER, still holding the stale generation.
    loader.invalidatePluginProviderSupportIndexLoad(genB);

    // The retry must still publish its result.
    await expect(retry).resolves.not.toBeNull();
    expect(
      loader
        .getCachedPluginProviderSupportIndex()
        ?.has(loader.pluginProviderSupportKey('agent-plugins', 'retry')),
    ).toBe(true);
    void sharedA;
  });
});
