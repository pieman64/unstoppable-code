const mockReadCache = jest.fn();
const mockRefresh = jest.fn();

jest.mock('@canopy/desktop-shared/node/ai-gateway-model-catalog', () => ({
  AI_GATEWAY_MODEL_CATALOG_TTL_MS: 15 * 60 * 1000,
  get readAiGatewayModelCatalogCache(): typeof mockReadCache {
    return mockReadCache;
  },
  get refreshAiGatewayModelCatalog(): typeof mockRefresh {
    return mockRefresh;
  },
}));

import { createAiGatewayModelCatalogService } from '../ai-gateway-models/service';
import type { AiGatewayCatalogStatus } from '@canopy/desktop-shared/types';

const catalog = { version: 1 as const, models: [] };

describe('desktop AI Gateway model catalog service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hydrates fresh cache without starting a network request', async () => {
    const onCatalog = jest.fn();
    mockReadCache.mockResolvedValue({
      freshness: 'fresh',
      entry: {
        fetchedAt: '2026-07-29T11:59:00.000Z',
        catalog,
      },
    });
    const service = createAiGatewayModelCatalogService({
      serverOrigin: 'https://cloud.example.com',
      brandApiNamespace: 'canopy',
      cacheFilePath: '/tmp/catalog.json',
      onCatalog,
    });
    await service.hydrate();
    service.start();
    expect(onCatalog).toHaveBeenCalledWith(catalog);
    expect(mockRefresh).not.toHaveBeenCalled();
    service.dispose();
  });

  it('serves stale cache and refreshes passively after start', async () => {
    const onCatalog = jest.fn();
    mockReadCache.mockResolvedValue({
      freshness: 'stale',
      entry: {
        fetchedAt: '2026-07-29T11:00:00.000Z',
        catalog,
      },
    });
    mockRefresh.mockResolvedValue({
      status: 'updated',
      cache: { catalog },
    });
    const service = createAiGatewayModelCatalogService({
      serverOrigin: 'https://cloud.example.com',
      brandApiNamespace: 'canopy',
      cacheFilePath: '/tmp/catalog.json',
      onCatalog,
    });
    await service.hydrate();
    expect(mockRefresh).not.toHaveBeenCalled();
    service.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onCatalog).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('retries failures while retaining the hydrated catalog and stops on dispose', async () => {
    mockReadCache.mockResolvedValue({ freshness: 'missing' });
    mockRefresh.mockResolvedValue({ status: 'failed', error: new Error('no') });
    const onCatalog = jest.fn();
    const service = createAiGatewayModelCatalogService({
      serverOrigin: 'https://cloud.example.com',
      brandApiNamespace: 'canopy',
      cacheFilePath: '/tmp/catalog.json',
      onCatalog,
    });
    await service.hydrate();
    service.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCatalog).not.toHaveBeenCalled();
    service.dispose();
    await jest.runOnlyPendingTimersAsync();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
  describe('catalog status', () => {
    function createService(): {
      service: ReturnType<typeof createAiGatewayModelCatalogService>;
      statuses: AiGatewayCatalogStatus[];
      onCatalog: jest.Mock;
    } {
      const statuses: AiGatewayCatalogStatus[] = [];
      const onCatalog = jest.fn();
      const service = createAiGatewayModelCatalogService({
        serverOrigin: 'https://cloud.example.com',
        brandApiNamespace: 'canopy',
        cacheFilePath: '/tmp/catalog.json',
        onCatalog,
        onStatus: (status) => {
          statuses.push(status);
        },
      });
      return { service, statuses, onCatalog };
    }

    async function flush(): Promise<void> {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    }

    it('starts loading and becomes ready from a cached catalog', async () => {
      mockReadCache.mockResolvedValue({
        freshness: 'fresh',
        entry: { fetchedAt: '2026-07-29T11:59:00.000Z', catalog },
      });
      const { service, statuses } = createService();
      expect(service.getStatus()).toBe('loading');
      await service.hydrate();
      service.start();
      expect(service.getStatus()).toBe('ready');
      expect(statuses).toEqual(['ready']);
      service.dispose();
    });

    it('reports failed when there is no cache and the fetch fails', async () => {
      mockReadCache.mockResolvedValue({ freshness: 'missing' });
      mockRefresh.mockResolvedValue({
        status: 'failed',
        error: new Error('offline'),
      });
      const { service, statuses } = createService();
      await service.hydrate();
      expect(service.getStatus()).toBe('loading');
      service.start();
      await flush();
      expect(service.getStatus()).toBe('failed');
      expect(statuses).toEqual(['failed']);
      service.dispose();
    });

    it('treats a rejected refresh as a failure without an unhandled rejection', async () => {
      mockReadCache.mockResolvedValue({ freshness: 'missing' });
      mockRefresh.mockRejectedValue(new Error('boom'));
      const { service } = createService();
      await service.hydrate();
      await expect(service.retry()).resolves.toBeUndefined();
      expect(service.getStatus()).toBe('failed');
      service.dispose();
    });

    it('retries immediately on request and becomes ready when it succeeds', async () => {
      mockReadCache.mockResolvedValue({ freshness: 'missing' });
      mockRefresh.mockResolvedValueOnce({
        status: 'failed',
        error: new Error('offline'),
      });
      const { service, statuses, onCatalog } = createService();
      await service.hydrate();
      service.start();
      await flush();
      expect(service.getStatus()).toBe('failed');

      mockRefresh.mockResolvedValueOnce({
        status: 'updated',
        cache: { catalog },
      });
      const retry = service.retry();
      expect(service.getStatus()).toBe('loading');
      await retry;
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      expect(onCatalog).toHaveBeenCalledWith(catalog);
      expect(service.getStatus()).toBe('ready');
      expect(statuses).toEqual(['failed', 'loading', 'ready']);

      // The pending 60s backoff retry was replaced by the TTL refresh.
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      service.dispose();
    });

    it('joins an in-flight attempt instead of starting a second fetch', async () => {
      mockReadCache.mockResolvedValue({ freshness: 'missing' });
      let resolveFetch: ((value: unknown) => void) | undefined;
      mockRefresh.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const { service } = createService();
      await service.hydrate();
      service.start();
      const retry = service.retry();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      resolveFetch?.({ status: 'updated', cache: { catalog } });
      await retry;
      expect(service.getStatus()).toBe('ready');
      service.dispose();
    });

    it('stays ready when a later refresh fails', async () => {
      mockReadCache.mockResolvedValue({
        freshness: 'stale',
        entry: { fetchedAt: '2026-07-29T11:00:00.000Z', catalog },
      });
      mockRefresh.mockResolvedValue({
        status: 'failed',
        error: new Error('offline'),
      });
      const { service, statuses } = createService();
      await service.hydrate();
      service.start();
      await flush();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(service.getStatus()).toBe('ready');
      expect(statuses).toEqual(['ready']);
      service.dispose();
    });

    it('does not refetch a loaded list on retry', async () => {
      mockReadCache.mockResolvedValue({
        freshness: 'fresh',
        entry: { fetchedAt: new Date().toISOString(), catalog },
      });
      const { service } = createService();
      await service.hydrate();
      service.start();
      await service.retry();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(service.getStatus()).toBe('ready');
      service.dispose();
    });
  });
});
