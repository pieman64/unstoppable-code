import type { MarketplaceSourceAddSession } from '@canopy/app-core/client';
import { createMarketplaceSourceOperations } from '@canopy/app-core/client';
import { createIpcMarketplaceSourceAddSession } from '../marketplace-source-add-session';
/* eslint-disable @typescript-eslint/require-await -- async fakes mirror the IPC promises they stand in for. */
import type {
  MarketplaceInfo,
  MarketplaceProviderStatus,
  MarketplaceRemovalResult,
  PluginDetails,
  PluginInfo,
  PluginsCache,
  PluginsAPI,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
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

  it('never publishes an old read begun during an update after that update completes', async () => {
    const update =
      deferred<Awaited<ReturnType<PluginsAPI['updateMarketplace']>>>();
    const staleRead =
      deferred<Awaited<ReturnType<PluginsAPI['loadMarketplaces']>>>();
    const updated = marketplace({ name: 'Updated source' });
    const sync = syncSpy();
    const load = jest
      .fn<ReturnType<PluginsAPI['loadMarketplaces']>, []>()
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValue({ success: true, data: cache(updated) });
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        updateMarketplace: () => update.promise,
        loadMarketplaces: load,
      }),
      sync,
    );
    const pendingUpdate = client.update('acme');
    const pendingRead = client.list();
    update.resolve({ success: true, data: updated });
    await pendingUpdate;
    staleRead.resolve({ success: true, data: cache(marketplace()) });
    expect((await pendingRead).sources[0]?.name).toBe('Updated source');
    expect(sync.cache).toHaveBeenCalledTimes(1);
    expect(sync.cache).toHaveBeenCalledWith(cache(updated));
  });

  it('stops re-reading when cache patches keep racing the read', async () => {
    let emit: ((patch: (cache: PluginsCache) => PluginsCache) => void) | null =
      null;
    const sync = {
      ...syncSpy(),
      subscribe: (
        listener: (patch: (cache: PluginsCache) => PluginsCache) => void,
      ): (() => void) => {
        emit = listener;
        return () => undefined;
      },
    };
    const loadMarketplaces = jest.fn(async () => {
      // Each read sees a cache patch land before it returns.
      emit?.((base) => base);
      return { success: true as const, data: cache() };
    });
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({ loadMarketplaces }),
      sync,
    );
    client.subscribeSnapshot?.(() => undefined);
    await expect(client.list()).rejects.toThrow(
      'Marketplaces changed while loading. Try again.',
    );
    expect(loadMarketplaces).toHaveBeenCalledTimes(3);
    expect(sync.cache).not.toHaveBeenCalled();
  });

  it('never resurrects a removed source from a read begun while removal was pending', async () => {
    const removal =
      deferred<Awaited<ReturnType<PluginsAPI['removeMarketplace']>>>();
    const staleRead =
      deferred<Awaited<ReturnType<PluginsAPI['loadMarketplaces']>>>();
    const sync = syncSpy();
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        removeMarketplace: () => removal.promise,
        loadMarketplaces: jest
          .fn<ReturnType<PluginsAPI['loadMarketplaces']>, []>()
          .mockReturnValueOnce(staleRead.promise)
          .mockResolvedValue({ success: true, data: cache() }),
      }),
      sync,
    );
    const pendingRemoval = client.remove('acme');
    const pendingRead = client.list();
    removal.resolve({
      success: true,
      data: {
        marketplace: null,
        removedProviders: ['claude', 'codex'],
        providerOutcomes: {
          claude: { removed: true, alreadyAbsent: false },
          codex: { removed: true, alreadyAbsent: false },
        },
      },
    });
    await pendingRemoval;
    staleRead.resolve({ success: true, data: cache(marketplace()) });
    expect((await pendingRead).sources).toEqual([]);
    expect(sync.cache).toHaveBeenCalledTimes(1);
    expect(sync.cache).toHaveBeenCalledWith(cache());
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
    const result: MarketplaceRemovalResult = {
      marketplace: null,
      removedProviders: ['claude', 'codex'],
      providerOutcomes: {
        claude: { removed: true, alreadyAbsent: false },
        codex: { removed: true, alreadyAbsent: false },
      },
    };
    const client = createIpcMarketplaceSourcesClient(
      pluginsApi({
        removeMarketplace: jest.fn(async () => ({
          success: true,
          data: result,
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

describe('desktop Add session (CAN-4267)', () => {
  function addFixture(): {
    add: jest.Mock<
      ReturnType<PluginsAPI['addMarketplace']>,
      Parameters<PluginsAPI['addMarketplace']>
    >;
    list: jest.Mock<Promise<readonly MarketplaceInfo[]>, []>;
    upsert: jest.Mock<void, [MarketplaceInfo]>;
    operations: ReturnType<typeof createMarketplaceSourceOperations>;
    session: MarketplaceSourceAddSession;
  } {
    const add = jest.fn<
      ReturnType<PluginsAPI['addMarketplace']>,
      Parameters<PluginsAPI['addMarketplace']>
    >();
    const list = jest
      .fn<Promise<readonly MarketplaceInfo[]>, []>()
      .mockResolvedValue([]);
    const upsert = jest.fn<void, [MarketplaceInfo]>();
    const operations = createMarketplaceSourceOperations();
    const session = createIpcMarketplaceSourceAddSession({
      add,
      list,
      upsert,
      operations,
    });
    return { add, list, upsert, operations, session };
  }

  it('constructs without transport calls and validates before registration', async () => {
    const f = addFixture();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.add).not.toHaveBeenCalled();
    await f.session.submit('not a repository');
    const state = f.session.getSnapshot();
    expect(state.phase).toBe('input');
    expect('error' in state && typeof state.error === 'string').toBe(true);
    expect(f.add).not.toHaveBeenCalled();
  });

  it('checks duplicates against authoritative inventory case-insensitively', async () => {
    const f = addFixture();
    f.list.mockResolvedValue([marketplace({ sourceUrl: 'Acme/Plugins' })]);
    await f.session.submit('acme/plugins');
    expect(f.add).not.toHaveBeenCalled();
    expect(f.session.getSnapshot()).toMatchObject({
      phase: 'input',
      error: 'Marketplace has already been added.',
    });
    expect(f.operations.getSnapshot().refreshing).toBe(false);
  });

  it('completes with a path-free identity and publishes registered invalid sources', async () => {
    const f = addFixture();
    const source = marketplace({
      validProviders: [],
      providerStatus: {
        claude: provider('claude', { state: 'invalid' }),
        codex: provider('codex', { state: 'invalid' }),
      },
    });
    f.add.mockResolvedValue({
      success: true,
      data: { marketplace: source, providerOutcomes: source.providerStatus },
    });
    await f.session.submit('acme/plugins');
    expect(f.session.getSnapshot()).toEqual({
      phase: 'complete',
      result: { sourceId: source.id },
    });
    expect(f.upsert).toHaveBeenCalledWith(source);
    expect(f.operations.getSnapshot()).toEqual({
      operations: {},
      refreshing: false,
    });
  });

  it('lets a rejected registration be retried after reopening the dialog', async () => {
    const f = addFixture();
    const error =
      'No Claude or Codex plugins were detected in that repository. Claude: rejected. Codex: rejected.';
    f.add.mockResolvedValueOnce({ success: false, error });
    await f.session.submit('acme/plugins');
    expect(f.session.getSnapshot()).toEqual({ phase: 'input', error });
    f.session.dispose();
    const source = marketplace();
    f.add.mockResolvedValueOnce({
      success: true,
      data: { marketplace: source, providerOutcomes: source.providerStatus },
    });
    const reopened = createIpcMarketplaceSourceAddSession({
      add: f.add,
      list: f.list,
      upsert: f.upsert,
      operations: f.operations,
    });
    await reopened.submit('acme/plugins');
    expect(reopened.getSnapshot()).toEqual({
      phase: 'complete',
      result: { sourceId: source.id },
    });
    expect(f.add).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected registration unverified while the inventory cannot be read', async () => {
    const f = addFixture();
    f.add.mockResolvedValueOnce({ success: false, error: 'Rejected.' });
    f.list
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([]);
    await f.session.submit('acme/plugins');
    expect(f.session.getSnapshot().phase).toBe('uncertain');
    await f.session.retryReconciliation();
    expect(f.session.getSnapshot()).toEqual({
      phase: 'input',
      error: 'Rejected.',
    });
  });

  it('blocks repeated Add and refresh while the registration request settles', async () => {
    const f = addFixture();
    let settle: (
      value: Awaited<ReturnType<PluginsAPI['addMarketplace']>>,
    ) => void = () => {};
    f.add.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const pending = f.session.submit('acme/plugins');
    await Promise.resolve();
    await f.session.submit('acme/plugins');
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.operations.acquire(null, 'update')).toBeNull();
    f.session.dispose();
    expect(f.operations.getSnapshot().refreshing).toBe(true);
    const source = marketplace();
    settle({
      success: true,
      data: { marketplace: source, providerOutcomes: source.providerStatus },
    });
    await pending;
    expect(f.upsert).toHaveBeenCalledWith(source);
    expect(f.session.getSnapshot()).toEqual({ phase: 'closed' });
    expect(f.operations.getSnapshot().refreshing).toBe(false);
  });

  it.each(['malformed', 'lost'] as const)(
    'reconciles %s responses and permits re-add after removal',
    async (response) => {
      const f = addFixture();
      if (response === 'lost')
        f.add.mockRejectedValue(new Error('response lost'));
      else f.add.mockResolvedValue({ success: true });
      await f.session.submit('acme/plugins');
      expect(f.session.getSnapshot().phase).toBe('uncertain');
      await f.session.submit('acme/plugins');
      expect(f.add).toHaveBeenCalledTimes(1);
      f.list.mockResolvedValue([marketplace()]);
      await f.session.retryReconciliation();
      expect(f.session.getSnapshot()).toEqual({
        phase: 'complete',
        result: { sourceId: 'acme' },
      });
      expect(f.add).toHaveBeenCalledTimes(1);
      // Authoritative inventory after the user removes the recovered source.
      f.list.mockResolvedValue([]);
      const source = marketplace();
      f.add.mockResolvedValue({
        success: true,
        data: { marketplace: source, providerOutcomes: source.providerStatus },
      });
      const readd = createIpcMarketplaceSourceAddSession({
        add: f.add,
        list: f.list,
        upsert: f.upsert,
        operations: f.operations,
      });
      await readd.submit('acme/plugins');
      expect(readd.getSnapshot()).toEqual({
        phase: 'complete',
        result: { sourceId: 'acme' },
      });
      expect(f.add).toHaveBeenCalledTimes(2);
    },
  );

  it('retains a still-running registration even when another session reconciles a visible source', async () => {
    const f = addFixture();
    const writing =
      deferred<Awaited<ReturnType<PluginsAPI['addMarketplace']>>>();
    f.add.mockReturnValue(writing.promise);
    const pending = f.session.submit('acme/plugins');
    await Promise.resolve();
    const source = marketplace();
    try {
      const sibling = createIpcMarketplaceSourceAddSession({
        add: f.add,
        list: f.list,
        upsert: f.upsert,
        operations: f.operations,
      });
      await sibling.submit('acme/plugins');
      f.list.mockResolvedValue([source]);
      await sibling.retryReconciliation();
      expect(sibling.getSnapshot().phase).toBe('complete');
      const next = createIpcMarketplaceSourceAddSession({
        add: f.add,
        list: f.list,
        upsert: f.upsert,
        operations: f.operations,
      });
      await next.submit('acme/plugins');
      expect(next.getSnapshot().phase).toBe('uncertain');
      expect(f.add).toHaveBeenCalledTimes(1);
      sibling.dispose();
      next.dispose();
    } finally {
      writing.resolve({
        success: true,
        data: { marketplace: source, providerOutcomes: source.providerStatus },
      });
      await pending;
      f.session.dispose();
    }
  });

  it('retains unresolved registration identity across dialog reopen', async () => {
    const f = addFixture();
    f.add.mockRejectedValue(new Error('response lost'));
    await f.session.submit('acme/plugins');
    f.session.dispose();
    const reopened = createIpcMarketplaceSourceAddSession({
      add: f.add,
      list: f.list,
      upsert: f.upsert,
      operations: f.operations,
    });
    await reopened.submit('ACME/PLUGINS');
    expect(reopened.getSnapshot().phase).toBe('uncertain');
    expect(f.add).toHaveBeenCalledTimes(1);
    reopened.dispose();
  });
});
