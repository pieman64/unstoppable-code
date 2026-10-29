jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => false,
}));
jest.mock('../mcp/curated-catalog', () => ({
  listCuratedMcpServers: jest.fn(),
}));
jest.mock('../mcp/tool-discovery', () => ({
  refreshStaleMcpTools: jest.fn(),
}));
jest.mock('../plugins/curated-plugin-sync', () => ({
  syncCuratedPlugins: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  syncCuratedPluginsForRefresh: jest.fn(),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));

import type { CuratedPluginSyncResult } from '../plugins/curated-plugin-sync';
import { syncCuratedPlugins } from '../plugins/curated-plugin-sync';
import { syncCuratedPluginsForRefresh } from '../plugins/plugin-service';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import {
  CURATED_MCP_REFRESH_INTERVAL_MS,
  runCuratedMcpRefresh,
  startCuratedMcpRefresh,
  type CuratedMcpRefreshDependencies,
} from '../mcp/refresh-scheduler';

function syncResult(
  status: CuratedPluginSyncResult['status'],
): CuratedPluginSyncResult {
  return { status, added: [], changed: [], removed: [], errors: [] };
}

function testDependencies(
  overrides: Partial<CuratedMcpRefreshDependencies> = {},
): CuratedMcpRefreshDependencies {
  return {
    refreshCatalog: jest.fn().mockResolvedValue(undefined),
    refreshTools: jest.fn().mockResolvedValue(undefined),
    syncCuratedPlugins: jest.fn().mockResolvedValue(syncResult('noop')),
    refreshInvocableInventory: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('curated MCP refresh scheduler', () => {
  it('still refreshes local tools when signed-out catalog refresh fails', async () => {
    const dependencies = testDependencies({
      refreshCatalog: jest.fn().mockRejectedValue(new Error('signed out')),
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    await runCuratedMcpRefresh(dependencies);
    expect(dependencies.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(dependencies.refreshTools).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('runs immediately, schedules the cross-platform interval, and is idempotent', async () => {
    const dependencies = testDependencies();
    const timer = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => timer);
    const clearIntervalFn = jest.fn();
    const options = {
      e2e: false,
      dependencies,
      setIntervalFn,
      clearIntervalFn,
    };

    const dispose = startCuratedMcpRefresh(options);
    const sameDispose = startCuratedMcpRefresh(options);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sameDispose).toBe(dispose);
    expect(dependencies.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(dependencies.refreshTools).toHaveBeenCalledTimes(1);
    expect(dependencies.syncCuratedPlugins).toHaveBeenCalledTimes(1);
    expect(setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      CURATED_MCP_REFRESH_INTERVAL_MS,
    );
    expect(timer.unref).toHaveBeenCalled();
    dispose();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it('no-ops every phase, including the curated plugin sync, for E2E builds', async () => {
    const dependencies = testDependencies();
    const timer = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => timer);
    const clearIntervalFn = jest.fn();

    const dispose = startCuratedMcpRefresh({
      e2e: true,
      dependencies,
      setIntervalFn,
      clearIntervalFn,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(dependencies.refreshCatalog).not.toHaveBeenCalled();
    expect(dependencies.refreshTools).not.toHaveBeenCalled();
    expect(dependencies.syncCuratedPlugins).not.toHaveBeenCalled();
    expect(dependencies.refreshInvocableInventory).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
    dispose();
  });

  it('runs the curated plugin sync phase on every cycle', async () => {
    const dependencies = testDependencies();

    await runCuratedMcpRefresh(dependencies);

    expect(dependencies.syncCuratedPlugins).toHaveBeenCalledTimes(1);
  });

  it('does not let a curated plugin sync failure gate the MCP catalog/tool phases', async () => {
    const dependencies = testDependencies({
      syncCuratedPlugins: jest.fn().mockRejectedValue(new Error('sync failed')),
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await runCuratedMcpRefresh(dependencies);

    expect(dependencies.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(dependencies.refreshTools).toHaveBeenCalledTimes(1);
    expect(dependencies.refreshInvocableInventory).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not let MCP catalog/tool phase failures gate the curated plugin sync phase', async () => {
    const dependencies = testDependencies({
      refreshCatalog: jest.fn().mockRejectedValue(new Error('catalog down')),
      refreshTools: jest.fn().mockRejectedValue(new Error('tools down')),
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await runCuratedMcpRefresh(dependencies);

    expect(dependencies.syncCuratedPlugins).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refreshes the invocable inventory after a synced curated plugin sync', async () => {
    const dependencies = testDependencies({
      syncCuratedPlugins: jest.fn().mockResolvedValue(syncResult('synced')),
    });

    await runCuratedMcpRefresh(dependencies);

    expect(dependencies.refreshInvocableInventory).toHaveBeenCalledTimes(1);
  });

  it.each<CuratedPluginSyncResult['status']>(['noop', 'skipped'])(
    'does not refresh the invocable inventory after a %s curated plugin sync',
    async (status) => {
      const dependencies = testDependencies({
        syncCuratedPlugins: jest.fn().mockResolvedValue(syncResult(status)),
      });

      await runCuratedMcpRefresh(dependencies);

      expect(dependencies.refreshInvocableInventory).not.toHaveBeenCalled();
    },
  );

  it('treats a null (already-logged) curated sync failure as non-committed', async () => {
    const dependencies = testDependencies({
      syncCuratedPlugins: jest.fn().mockResolvedValue(null),
    });

    await expect(runCuratedMcpRefresh(dependencies)).resolves.toBeUndefined();

    expect(dependencies.refreshInvocableInventory).not.toHaveBeenCalled();
  });

  describe('default dependencies', () => {
    it('routes the sync through the plugin service so a scheduler-committed sync gets the full post-sync reaction', async () => {
      // Calling the sync engine directly would leave the curated scan memo
      // stale and never nudge the providers, and `updateMarketplace` refuses
      // the curated marketplace so there is no manual heal.
      jest.clearAllMocks();
      jest
        .mocked(syncCuratedPluginsForRefresh)
        .mockResolvedValue(syncResult('synced'));

      await runCuratedMcpRefresh();

      expect(syncCuratedPluginsForRefresh).toHaveBeenCalledTimes(1);
      expect(syncCuratedPlugins).not.toHaveBeenCalled();
      expect(refreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
        'curated-plugin-sync',
      );
    });
  });

  it('does not let an invocable inventory refresh failure escape runCuratedMcpRefresh', async () => {
    const dependencies = testDependencies({
      syncCuratedPlugins: jest.fn().mockResolvedValue(syncResult('synced')),
      refreshInvocableInventory: jest
        .fn()
        .mockRejectedValue(new Error('inventory refresh failed')),
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    await expect(runCuratedMcpRefresh(dependencies)).resolves.toBeUndefined();

    warn.mockRestore();
  });
});
