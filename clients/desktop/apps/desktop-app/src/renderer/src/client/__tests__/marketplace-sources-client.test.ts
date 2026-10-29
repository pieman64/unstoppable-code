/* eslint-disable @typescript-eslint/require-await -- async fakes mirror the IPC promises they stand in for. */
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  MarketplaceRemovalResult,
  PluginDetails,
  PluginInfo,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import {
  formatMarketplaceRemoveBodyCopy,
  marketplaceSourceValidProviders,
  toMarketplaceSource,
  toMarketplaceSourcePlugin,
} from '../marketplace-source-summary';
import {
  createIpcMarketplaceSourcesClient,
  type IpcMarketplaceSourcesCacheSync,
} from '../ipc-marketplace-sources-client';

const details: PluginDetails = {
  skills: [],
  agents: [],
  commands: [],
  hooks: [],
  mcpServers: [],
  lspServers: [],
  hasReadme: false,
};

function provider(
  name: 'claude' | 'codex',
  overrides: Partial<MarketplaceProviderStatus> = {},
): MarketplaceProviderStatus {
  return {
    provider: name,
    state: 'valid',
    accepted: true,
    pluginCount: 1,
    lastCheckedAt: '2026-10-19T00:00:00.000Z',
    marketplacePath: '/Users/me/.claude/plugins/marketplaces/x',
    installLocation: '/Users/me/.claude/plugins/x',
    ...overrides,
  };
}

function plugin(overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'lint',
    sourcePath: '/Users/me/repo/plugins/lint',
    marketplaceId: 'acme',
    providerSupport: { claude: 'native', codex: 'compat' },
    facets: {},
    ...overrides,
  };
}

function marketplace(
  overrides: Partial<MarketplaceInfo> = {},
): MarketplaceInfo {
  return {
    id: 'acme',
    name: 'Acme',
    sourceType: 'github',
    sourceUrl: 'acme/plugins',
    installLocation: '/Users/me/.claude/plugins/acme',
    pluginCount: 1,
    plugins: [plugin()],
    providerStatus: { claude: provider('claude'), codex: provider('codex') },
    validProviders: ['claude', 'codex'],
    ...overrides,
  };
}

describe('toMarketplaceSource', () => {
  it('projects a GitHub row without host paths', () => {
    const source = toMarketplaceSource(marketplace());
    expect(source).toMatchObject({
      id: 'acme',
      kind: 'github',
      sourceLabel: 'acme/plugins',
      sourceUrl: 'https://github.com/acme/plugins',
      status: { state: 'valid', errors: [] },
      actions: { update: true, remove: true },
    });
    expect(JSON.stringify(source)).not.toContain('/Users/me');
  });

  it('never exposes a local source path as label or link', () => {
    const source = toMarketplaceSource(
      marketplace({ sourceType: 'local', sourceUrl: '/Users/me/repo' }),
    );
    expect(source.sourceLabel).toBe('local');
    expect(source.sourceUrl).toBeUndefined();
  });

  it('keeps legacy built-in and curated restrictions', () => {
    expect(toMarketplaceSource(marketplace({ builtIn: true })).actions).toEqual(
      { update: true, remove: false },
    );
    expect(toMarketplaceSource(marketplace({ curated: true })).actions).toEqual(
      { update: false, remove: false },
    );
    expect(
      toMarketplaceSource(marketplace({ removable: false })).actions.remove,
    ).toBe(false);
  });

  it('marks a row with no valid providers invalid and keeps provider errors', () => {
    const source = toMarketplaceSource(
      marketplace({
        validProviders: [],
        providerStatus: {
          claude: provider('claude', { state: 'invalid', error: 'Not found' }),
          codex: provider('codex', {
            state: 'invalid',
            structurallyInvalidAtRevision: 'abc',
          }),
        },
      }),
    );
    expect(source.status.state).toBe('invalid');
    expect(source.status.errors).toEqual([
      { label: 'Claude', message: 'Not found', provider: 'claude' },
    ]);
    expect(source.status.note).toMatch(/Codex support/);
  });

  it('falls back to a safe error when providers gave no text', () => {
    const source = toMarketplaceSource(
      marketplace({
        validProviders: [],
        providerStatus: {
          claude: provider('claude', { state: 'invalid' }),
          codex: provider('codex', { state: 'invalid' }),
        },
      }),
    );
    expect(source.status.state).toBe('invalid');
    expect(source.status.errors).toHaveLength(1);
  });

  it('never marks managed rows invalid', () => {
    const source = toMarketplaceSource(
      marketplace({ builtIn: true, validProviders: [] }),
    );
    expect(source.status.state).toBe('valid');
  });

  it('names the providers a removal affects', () => {
    const source = toMarketplaceSource(
      marketplace({
        providerStatus: {
          claude: provider('claude'),
          codex: provider('codex', { state: 'invalid' }),
        },
      }),
    );
    expect(marketplaceSourceValidProviders(source)).toEqual(['claude']);
    expect(formatMarketplaceRemoveBodyCopy(['claude'])).toContain(
      'from Claude.',
    );
  });
});

describe('toMarketplaceSourcePlugin', () => {
  it('preserves pluginNeedsInstall semantics', () => {
    const external = {
      externalSource: { source: 'github', url: 'https://github.com/a/b' },
    };
    for (const info of [
      plugin(external),
      plugin({ ...external, details }),
      plugin({
        ...external,
        facets: {
          codexCompatibility: {
            provider: 'codex',
            mode: 'compat',
            name: 'lint',
            installLocation: '/x',
            sourcePath: '/x',
            details,
          },
        },
      }),
      plugin(),
    ]) {
      const state = toMarketplaceSourcePlugin(info).installState;
      expect(state?.externalSource === true && !state.hasContent).toBe(
        pluginNeedsInstall(info),
      );
    }
  });

  it('drops install paths from provider install state', () => {
    const projected = toMarketplaceSourcePlugin(
      plugin({
        globalInstallStatus: {
          checkedAt: '2026-10-19T00:00:00.000Z',
          claude: {
            available: true,
            installed: true,
            installPath: '/Users/me/.claude/plugins/lint',
          },
        },
      }),
    );
    expect(projected.installState?.providers.claude).toEqual({
      available: true,
      installed: true,
    });
  });
});

function cache(...marketplaces: MarketplaceInfo[]): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-10-19T00:00:00.000Z',
    marketplaces,
  };
}

function syncSpy(): jest.Mocked<IpcMarketplaceSourcesCacheSync> {
  return {
    cache: jest.fn(),
    upsert: jest.fn(),
    remove: jest.fn(),
    plugin: jest.fn(),
  };
}

function pluginsApi(
  overrides: Partial<
    Parameters<typeof createIpcMarketplaceSourcesClient>[0]
  > = {},
): Parameters<typeof createIpcMarketplaceSourcesClient>[0] {
  return {
    loadMarketplaces: jest.fn(async () => ({
      success: true,
      data: cache(marketplace()),
    })),
    refreshMarketplaces: jest.fn(async () => ({
      success: true,
      data: cache(marketplace()),
    })),
    updateMarketplace: jest.fn(async () => ({
      success: true,
      data: marketplace({ name: 'Acme updated' }),
    })),
    removeMarketplace: jest.fn(),
    installPlugin: jest.fn(),
    onMarketplaceOperationProgress: jest.fn(() => () => undefined),
    ...overrides,
  };
}

describe('createIpcMarketplaceSourcesClient', () => {
  it('reconciles from the backend even when a renderer snapshot exists', async () => {
    const sync = {
      ...syncSpy(),
      current: (): PluginsCache => cache(marketplace()),
    };
    const authoritative = cache(marketplace({ name: 'Backend state' }));
    const api = pluginsApi({
      loadMarketplaces: jest.fn(async () => ({
        success: true,
        data: authoritative,
      })),
    });
    const client = createIpcMarketplaceSourcesClient(api, sync);
    expect((await client.list()).sources[0]?.name).toBe('Backend state');
    expect(api.loadMarketplaces).toHaveBeenCalledTimes(1);
    expect(sync.cache).toHaveBeenCalledWith(authoritative);
  });

  it('forces provider updates on refresh and syncs legacy caches', async () => {
    const api = pluginsApi();
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(api, sync);
    const snapshot = await client.refreshAll();
    expect(api.refreshMarketplaces).toHaveBeenCalledWith('always');
    expect(sync.cache).toHaveBeenCalled();
    expect(snapshot.sources[0]?.id).toBe('acme');
  });

  it('rejects with the IPC error text', async () => {
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        updateMarketplace: jest.fn(async () => ({
          success: false,
          error: 'git fetch failed',
        })),
      }),
      syncSpy(),
    );
    await expect(client.update('acme')).rejects.toThrow('git fetch failed');
  });

  it('returns the authoritative row after update', async () => {
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(pluginsApi(), sync);
    expect((await client.update('acme')).name).toBe('Acme updated');
    expect(sync.upsert).toHaveBeenCalled();
  });

  it('keeps the survivor and a warning on partial removal', async () => {
    const result: MarketplaceRemovalResult = {
      marketplace: marketplace(),
      removedProviders: ['claude'],
      providerOutcomes: {
        claude: { removed: true, alreadyAbsent: false },
        codex: { removed: false, alreadyAbsent: false, error: 'busy' },
      },
    };
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        removeMarketplace: jest.fn(async () => ({
          success: true,
          data: result,
        })),
      }),
      sync,
    );
    const removal = await client.remove('acme');
    expect(removal.removed).toBe(false);
    expect(removal.removed ? '' : removal.warning).toContain('Codex: busy');
    expect(sync.remove).toHaveBeenCalledWith('acme', result);
  });

  it('confirms absence on full removal', async () => {
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        removeMarketplace: jest.fn(async () => ({
          success: true,
          data: {
            marketplace: null,
            removedProviders: ['claude', 'codex'],
            providerOutcomes: {
              claude: { removed: true, alreadyAbsent: false },
              codex: { removed: true, alreadyAbsent: false },
            },
          },
        })),
      }),
      syncSpy(),
    );
    expect(await client.remove('acme')).toEqual({ removed: true });
  });

  it('installs by plugin key with the cached source URL', async () => {
    const external = plugin({
      externalSource: { source: 'github', url: 'https://github.com/a/lint' },
    });
    const installed = { ...external, details };
    const installPlugin = jest.fn(async () => ({
      success: true,
      data: installed,
    }));
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        loadMarketplaces: jest.fn(async () => ({
          success: true,
          data: cache(marketplace({ plugins: [external] })),
        })),
        installPlugin,
      }),
      sync,
    );
    const result = await client.installPlugin?.('acme', 'lint');
    expect(installPlugin).toHaveBeenCalledWith(
      'acme',
      'lint',
      'https://github.com/a/lint',
    );
    expect(result?.plugin.installState?.hasContent).toBe(true);
    expect(sync.plugin).toHaveBeenCalledWith('acme', 'lint', installed);
  });

  it('maps progress without inventing a source', () => {
    let emit: (progress: {
      operation: 'refresh' | 'add';
      status: 'running';
      message: string;
      marketplaceId?: string;
    }) => void = () => undefined;
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        onMarketplaceOperationProgress: jest.fn((callback) => {
          emit = callback;
          return (): void => undefined;
        }),
      }),
      syncSpy(),
    );
    const listener = jest.fn();
    client.subscribeProgress?.(listener);
    emit({ operation: 'refresh', status: 'running', message: 'Checking' });
    emit({ operation: 'add', status: 'running', message: 'Adding' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      operation: 'refresh',
      status: 'running',
      message: 'Checking',
    });
  });
  it('preserves the source-scoped key when installed manifest name differs', async () => {
    const external = plugin({
      externalSource: { source: 'github', url: 'https://github.com/a/lint' },
    });
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        loadMarketplaces: jest.fn(async () => ({
          success: true,
          data: cache(marketplace({ plugins: [external] })),
        })),
        installPlugin: jest.fn(async () => ({
          success: true,
          data: { ...external, name: 'manifest-lint', details },
        })),
      }),
      sync,
    );
    const result = await client.installPlugin?.('acme', 'lint');
    expect(result?.plugin.key).toBe('lint');
    expect(result?.plugin.name).toBe('manifest-lint');
    expect(sync.plugin).toHaveBeenCalledWith(
      'acme',
      'lint',
      expect.objectContaining({ name: 'lint', displayName: 'manifest-lint' }),
    );
  });
});
