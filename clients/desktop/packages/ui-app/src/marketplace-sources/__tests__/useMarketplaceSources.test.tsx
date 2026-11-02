/**
 * @jest-environment jsdom
 */
/* eslint-disable @typescript-eslint/require-await -- act() callbacks stay async so React flushes the settled promises they trigger. */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MarketplaceSourcesClient,
  MarketplaceSourcesSnapshot,
} from '@canopy/app-core/client';
import {
  resolveMarketplaceSourcesAccess,
  useMarketplaceSourcesAccess,
  useMarketplaceSources,
  type MarketplaceSourcesAccess,
  type UseMarketplaceSourcesResult,
} from '../useMarketplaceSources';
import {
  installedState,
  marketplaceSource,
  missingInstallState,
  sourcePlugin,
} from './fixtures';

let mockAccessClient: Parameters<typeof resolveMarketplaceSourcesAccess>[0] = {
  capabilities: {},
};
jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCanopyClient: (): typeof mockAccessClient => mockAccessClient,
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(
  ...sources: ReturnType<typeof marketplaceSource>[]
): MarketplaceSourcesSnapshot {
  return { sources, lastRefreshedAt: '2026-10-19T00:00:00.000Z' };
}

function fakeClient(
  overrides: Partial<MarketplaceSourcesClient> = {},
): jest.Mocked<MarketplaceSourcesClient> {
  return {
    list: jest.fn(async () => snapshot(marketplaceSource('a'))),
    refreshAll: jest.fn(async () => snapshot(marketplaceSource('a'))),
    update: jest.fn(async (id: string) => marketplaceSource(id)),
    remove: jest.fn(async () => ({ removed: true as const })),
    ...overrides,
  } as jest.Mocked<MarketplaceSourcesClient>;
}

let container: HTMLDivElement;
let root: Root;
let latest: UseMarketplaceSourcesResult;

function Harness({
  access,
  enabled,
}: {
  access: MarketplaceSourcesAccess;
  enabled: boolean;
}): null {
  latest = useMarketplaceSources(access, { enabled });
  return null;
}

async function render(
  access: MarketplaceSourcesAccess,
  enabled = true,
): Promise<void> {
  await act(async () => {
    root.render(<Harness access={access} enabled={enabled} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe('resolveMarketplaceSourcesAccess', () => {
  const client = fakeClient({ installPlugin: jest.fn() });

  it('denies when the capability or member is missing', () => {
    expect(
      resolveMarketplaceSourcesAccess({
        capabilities: {},
        marketplaceSources: client,
      }).client,
    ).toBeNull();
    expect(
      resolveMarketplaceSourcesAccess({
        capabilities: { marketplaceSources: true },
      }).client,
    ).toBeNull();
  });

  it('gates install on both capability and method', () => {
    expect(
      resolveMarketplaceSourcesAccess({
        capabilities: { marketplaceSources: true },
        marketplaceSources: client,
      }).canInstall,
    ).toBe(false);
    expect(
      resolveMarketplaceSourcesAccess({
        capabilities: {
          marketplaceSources: true,
          marketplaceSourcePluginInstall: true,
        },
        marketplaceSources: fakeClient(),
      }).canInstall,
    ).toBe(false);
    expect(
      resolveMarketplaceSourcesAccess({
        capabilities: {
          marketplaceSources: true,
          marketplaceSourcePluginInstall: true,
        },
        marketplaceSources: client,
      }),
    ).toEqual({ client, canInstall: true });
  });
});

describe('useMarketplaceSources', () => {
  it('retains source ownership across hide/reopen until the install settles', async () => {
    const pending =
      deferred<
        Awaited<
          ReturnType<NonNullable<MarketplaceSourcesClient['installPlugin']>>
        >
      >();
    const remove = jest.fn(async () => ({ removed: true as const }));
    const client = fakeClient({
      installPlugin: jest.fn(() => pending.promise),
      remove,
    });
    const access = { client, canInstall: true };
    await render(access);
    let install!: Promise<boolean | null>;
    act(() => {
      install = latest.installPlugin('a', 'lint');
    });
    await render(access, false);
    await render(access);
    expect(latest.operations.a).toBe('install');
    await act(async () => {
      expect(await latest.remove('a')).toBe(false);
    });
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve({
        sourceId: 'a',
        plugin: sourcePlugin('lint', { installState: installedState() }),
        providerOutcomes: {},
      });
      await install;
    });
    expect(latest.operations.a).toBeUndefined();
    expect(latest.sources?.[0]?.id).toBe('a');
  });

  it('keeps ownership across unmounts of views using the same client', async () => {
    const pending = deferred<ReturnType<typeof marketplaceSource>>();
    const client = fakeClient({ update: jest.fn(() => pending.promise) });
    const access = { client, canInstall: false };
    await render(access);
    let updating!: Promise<boolean>;
    act(() => {
      updating = latest.update('a');
    });
    act(() => root.unmount());
    root = createRoot(container);
    await render(access);
    expect(latest.operations.a).toBe('update');
    await act(async () => {
      expect(await latest.remove('a')).toBe(false);
    });
    await act(async () => {
      pending.resolve(marketplaceSource('a'));
      await updating;
    });
    expect(latest.operations.a).toBeUndefined();
    expect(latest.sources?.[0]?.id).toBe('a');
  });

  it('does not fetch while the surface is hidden', async () => {
    const list = jest.fn(async () => snapshot(marketplaceSource('a')));
    const client = fakeClient({ list });
    await render({ client, canInstall: false }, false);
    expect(list).not.toHaveBeenCalled();
    expect(latest.sources).toBeNull();
    expect(latest.loading).toBe(false);

    await render({ client, canInstall: false }, true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(latest.sources?.map((source) => source.id)).toEqual(['a']);
  });

  it('keeps rows when a refresh fails', async () => {
    const client = fakeClient({
      refreshAll: jest.fn(async () => {
        throw new Error('GitHub is unreachable');
      }),
    });
    await render({ client, canInstall: false });
    await act(async () => {
      await latest.refresh();
    });
    expect(latest.sources?.map((source) => source.id)).toEqual(['a']);
    expect(latest.listError).toBe('GitHub is unreachable');
    expect(latest.refreshing).toBe(false);
  });

  it('discards a read that started before a removal', async () => {
    const slow = deferred<MarketplaceSourcesSnapshot>();
    const list = jest
      .fn<Promise<MarketplaceSourcesSnapshot>, []>()
      .mockResolvedValueOnce(
        snapshot(marketplaceSource('a'), marketplaceSource('b')),
      )
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue(snapshot(marketplaceSource('b')));
    const client = fakeClient({ list });
    await render({ client, canInstall: false });

    let reload: Promise<void> | undefined;
    act(() => {
      reload = latest.reload();
    });
    await act(async () => {
      await latest.remove('a');
    });
    expect(latest.sources?.map((source) => source.id)).toEqual(['b']);

    await act(async () => {
      slow.resolve(snapshot(marketplaceSource('a'), marketplaceSource('b')));
      await reload;
    });
    expect(latest.sources?.map((source) => source.id)).toEqual(['b']);
  });

  it('keeps the surviving source and warning on partial removal', async () => {
    const survivor = marketplaceSource('a', { name: 'Survivor' });
    const client = fakeClient({
      remove: jest.fn(async () => ({
        removed: false as const,
        source: survivor,
        warning: 'Codex still lists this marketplace.',
      })),
      list: jest.fn(async () => snapshot(survivor)),
    });
    await render({ client, canInstall: false });
    await act(async () => {
      await latest.remove('a');
    });
    expect(latest.sources?.[0]?.name).toBe('Survivor');
    expect(latest.sourceWarnings.a).toBe('Codex still lists this marketplace.');
  });

  it('prevents overlapping operations on one source', async () => {
    const pending = deferred<ReturnType<typeof marketplaceSource>>();
    const remove = jest.fn();
    const client = fakeClient({
      update: jest.fn(() => pending.promise),
      remove,
    });
    await render({ client, canInstall: false });

    let first: Promise<boolean> | undefined;
    act(() => {
      first = latest.update('a');
    });
    expect(latest.operations.a).toBe('update');
    let second: boolean | undefined;
    await act(async () => {
      second = await latest.remove('a');
    });
    expect(second).toBe(false);
    expect(remove).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(marketplaceSource('a', { name: 'Updated' }));
      await first;
    });
    expect(latest.operations.a).toBeUndefined();
  });

  it('reloads after a failed update so uncertain outcomes reconcile', async () => {
    const list = jest.fn(async () => snapshot(marketplaceSource('a')));
    const client = fakeClient({
      list,
      update: jest.fn(async () => {
        throw new Error('Revision changed. Try again.');
      }),
    });
    await render({ client, canInstall: false });
    await act(async () => {
      await latest.update('a');
    });
    expect(latest.sourceErrors.a).toBe('Revision changed. Try again.');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('applies the authoritative plugin and records provider failures', async () => {
    const plugin = sourcePlugin('p', { installState: missingInstallState() });
    const client = fakeClient({
      list: jest.fn(async () =>
        snapshot(marketplaceSource('a', { plugins: [plugin] })),
      ),
      installPlugin: jest.fn(async () => ({
        sourceId: 'a',
        plugin: { ...plugin, installState: installedState() },
        providerOutcomes: {
          claude: { installed: true },
          codex: { installed: false, error: 'Codex rejected it' },
        },
      })),
    });
    await render({ client, canInstall: true });
    let ok: boolean | null | undefined;
    await act(async () => {
      ok = await latest.installPlugin('a', 'p');
    });
    expect(ok).toBe(true);
    expect(latest.sources?.[0]?.plugins[0]?.installState?.hasContent).toBe(
      true,
    );
    expect(Object.values(latest.pluginErrors)).toEqual(['Codex rejected it']);
    expect(latest.installingPlugins.a).toBeUndefined();
  });

  it('reports no-content installs as failures', async () => {
    const plugin = sourcePlugin('p', { installState: missingInstallState() });
    const client = fakeClient({
      list: jest.fn(async () =>
        snapshot(marketplaceSource('a', { plugins: [plugin] })),
      ),
      installPlugin: jest.fn(async () => ({
        sourceId: 'a',
        plugin,
        providerOutcomes: {},
      })),
    });
    await render({ client, canInstall: true });
    let ok: boolean | null | undefined;
    await act(async () => {
      ok = await latest.installPlugin('a', 'p');
    });
    expect(ok).toBe(false);
    expect(Object.values(latest.pluginErrors)).toHaveLength(1);
  });

  it('never installs without the install capability', async () => {
    const installPlugin = jest.fn();
    const client = fakeClient({ installPlugin });
    await render({ client, canInstall: false });
    await act(async () => {
      await latest.installPlugin('a', 'p');
    });
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('attributes only scoped progress to rows', async () => {
    let emit: Parameters<
      NonNullable<MarketplaceSourcesClient['subscribeProgress']>
    >[0] = () => undefined;
    const unsubscribe = jest.fn();
    const client = fakeClient({
      subscribeProgress: jest.fn((listener) => {
        emit = listener;
        return unsubscribe;
      }),
    });
    await render({ client, canInstall: false });
    act(() => {
      emit({ operation: 'refresh', status: 'running', message: 'Syncing…' });
      emit({
        sourceId: 'a',
        operation: 'update',
        status: 'running',
        message: 'Pulling…',
      });
    });
    expect(latest.listProgress).toBe('Syncing…');
    expect(latest.sourceProgress).toEqual({ a: 'Pulling…' });

    await render({ client, canInstall: false }, false);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('clears per-source refresh progress when the list refresh ends', async () => {
    let emit: Parameters<
      NonNullable<MarketplaceSourcesClient['subscribeProgress']>
    >[0] = () => undefined;
    const client = fakeClient({
      subscribeProgress: jest.fn((listener) => {
        emit = listener;
        return (): void => undefined;
      }),
    });
    await render({ client, canInstall: false });
    act(() => {
      emit({ operation: 'refresh', status: 'running', message: 'Checking…' });
      emit({
        sourceId: 'a',
        operation: 'refresh',
        status: 'running',
        message: 'Checking a…',
      });
      emit({
        sourceId: 'b',
        operation: 'update',
        status: 'running',
        message: 'Pulling b…',
      });
    });
    expect(latest.sourceProgress).toEqual({
      a: 'Checking a…',
      b: 'Pulling b…',
    });
    // The host only reports completion for the whole refresh, not per row.
    act(() => {
      emit({ operation: 'refresh', status: 'complete', message: 'Done.' });
    });
    expect(latest.listProgress).toBeNull();
    expect(latest.sourceProgress).toEqual({ b: 'Pulling b…' });
  });

  it('clears per-source refresh progress when refreshAll settles', async () => {
    let emit: Parameters<
      NonNullable<MarketplaceSourcesClient['subscribeProgress']>
    >[0] = () => undefined;
    const pending = deferred<MarketplaceSourcesSnapshot>();
    const client = fakeClient({
      refreshAll: jest.fn(() => pending.promise),
      subscribeProgress: jest.fn((listener) => {
        emit = listener;
        return (): void => undefined;
      }),
    });
    await render({ client, canInstall: false });
    let refreshing: Promise<void> | undefined;
    act(() => {
      refreshing = latest.refresh();
      emit({
        sourceId: 'a',
        operation: 'refresh',
        status: 'running',
        message: 'Checking a…',
      });
    });
    expect(latest.sourceProgress).toEqual({ a: 'Checking a…' });
    await act(async () => {
      pending.resolve(snapshot(marketplaceSource('a')));
      await refreshing;
    });
    expect(latest.sourceProgress).toEqual({});
  });
  it('keeps the install indicator when a duplicate is rejected and blocks refresh', async () => {
    const pending = deferred<{
      sourceId: string;
      plugin: ReturnType<typeof sourcePlugin>;
      providerOutcomes: Record<string, never>;
    }>();
    const plugin = sourcePlugin('p', { installState: missingInstallState() });
    const client = fakeClient({
      list: jest.fn(async () =>
        snapshot(marketplaceSource('a', { plugins: [plugin] })),
      ),
      installPlugin: jest.fn(() => pending.promise),
    });
    await render({ client, canInstall: true });
    let first: Promise<boolean | null> | undefined;
    act(() => {
      first = latest.installPlugin('a', 'p');
    });
    await act(async () => {
      expect(await latest.installPlugin('a', 'other')).toBe(false);
      await latest.refresh();
    });
    expect(latest.installingPlugins.a).toBe('p');
    expect(client.refreshAll.mock.calls).toHaveLength(0);
    await act(async () => {
      pending.resolve({
        sourceId: 'a',
        plugin: { ...plugin, installState: installedState() },
        providerOutcomes: {},
      });
      await first;
    });
  });

  it('holds the mutation lock until uncertain outcomes have been reloaded', async () => {
    const reconciliation = deferred<MarketplaceSourcesSnapshot>();
    const client = fakeClient({
      list: jest
        .fn()
        .mockResolvedValueOnce(snapshot(marketplaceSource('a')))
        .mockReturnValue(reconciliation.promise),
      remove: jest.fn(async () => {
        throw new Error('Connection lost');
      }),
    });
    await render({ client, canInstall: false });
    let removal: Promise<boolean> | undefined;
    await act(async () => {
      removal = latest.remove('a');
    });
    expect(latest.operations.a).toBe('remove');
    await act(async () => {
      expect(await latest.remove('a')).toBe(false);
    });
    expect(client.remove.mock.calls).toHaveLength(1);
    await act(async () => {
      reconciliation.resolve(snapshot());
      await removal;
    });
    expect(latest.sources).toEqual([]);
    expect(latest.operations.a).toBeUndefined();
  });

  it('discards old operations after hiding and reopening the same client', async () => {
    const old = deferred<ReturnType<typeof marketplaceSource>>();
    const client = fakeClient({ update: jest.fn(() => old.promise) });
    await render({ client, canInstall: false });
    let operation: Promise<boolean> | undefined;
    act(() => {
      operation = latest.update('a');
    });
    await render({ client, canInstall: false }, false);
    await render({ client, canInstall: false });
    await act(async () => {
      old.resolve(marketplaceSource('a', { name: 'Stale' }));
      await operation;
    });
    expect(latest.sources?.[0]?.name).not.toBe('Stale');
  });

  it('does not count an install without authoritative install state as success', async () => {
    const client = fakeClient({
      installPlugin: jest.fn(async () => ({
        sourceId: 'a',
        plugin: sourcePlugin('p'),
        providerOutcomes: {},
      })),
    });
    await render({ client, canInstall: true });
    await act(async () => {
      expect(await latest.installPlugin('a', 'p')).toBe(false);
    });
  });

  it('applies external legacy cache snapshots without another request', async () => {
    let publish: (next: MarketplaceSourcesSnapshot) => void = () => undefined;
    const unsubscribe = jest.fn();
    const client = fakeClient({
      subscribeSnapshot: (listener) => {
        publish = listener;
        return unsubscribe;
      },
    });
    await render({ client, canInstall: false });
    act(() => {
      publish(snapshot(marketplaceSource('legacy')));
    });
    expect(latest.sources?.map((source) => source.id)).toEqual(['legacy']);
    expect(client.list.mock.calls).toHaveLength(1);
    await render({ client, canInstall: false }, false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain install unknown and refuses retries until a successful read', async () => {
    const plugin = sourcePlugin('p', { installState: missingInstallState() });
    const list = jest
      .fn()
      .mockResolvedValueOnce(
        snapshot(marketplaceSource('a', { plugins: [plugin] })),
      )
      .mockRejectedValueOnce(new Error('Offline'));
    const installPlugin = jest.fn(async () => {
      throw new Error('Reply lost');
    });
    const client = fakeClient({ list, installPlugin });
    await render({ client, canInstall: true });
    await act(async () => {
      expect(await latest.installPlugin('a', 'p')).toBeNull();
    });
    await act(async () => {
      expect(await latest.installPlugin('a', 'p')).toBeNull();
    });
    expect(installPlugin).toHaveBeenCalledTimes(1);
    list.mockResolvedValue(
      snapshot(
        marketplaceSource('a', {
          plugins: [{ ...plugin, installState: installedState() }],
        }),
      ),
    );
    await act(async () => {
      await latest.reload();
    });
    expect(latest.sources?.[0]?.plugins[0]?.installState?.hasContent).toBe(
      true,
    );
  });
});

it('follows a composite source-client replacement without requiring a new provider object (CAN-4267)', async () => {
  const first = fakeClient();
  const second = fakeClient();
  const composite = {
    capabilities: { marketplaceSources: true },
    marketplaceSources: first,
  };
  mockAccessClient = composite;
  let selected: MarketplaceSourcesAccess | null = null;
  function AccessHarness(): null {
    selected = useMarketplaceSourcesAccess();
    return null;
  }
  await act(async () => root.render(<AccessHarness />));
  expect(selected).toMatchObject({ client: first });
  composite.marketplaceSources = second;
  await act(async () => root.render(<AccessHarness />));
  expect(selected).toMatchObject({ client: second });
});
