import {
  AI_GATEWAY_MODEL_CATALOG_TTL_MS,
  readAiGatewayModelCatalogCache,
  refreshAiGatewayModelCatalog,
} from '@canopy/desktop-shared/node/ai-gateway-model-catalog';
import { getAiGatewayModelCatalogCacheFilePath } from '@canopy/desktop-shared/canopy-paths';
import type { AiGatewayModelCatalogResponse } from '@canopy/protocol/ai-gateway-models';
import type { AiGatewayCatalogStatus } from '@canopy/desktop-shared/types';

const RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 480_000, 900_000];

export interface AiGatewayModelCatalogService {
  hydrate(): Promise<void>;
  start(): void;
  /**
   * Attempt a fetch now, resetting the retry backoff. Joins an attempt that
   * is already in flight. Resolves (never rejects) when the attempt finishes.
   */
  retry(): Promise<void>;
  getStatus(): AiGatewayCatalogStatus;
  dispose(): void;
}

export function createAiGatewayModelCatalogService(options: {
  serverOrigin: string;
  brandApiNamespace: string;
  onCatalog: (catalog: AiGatewayModelCatalogResponse) => void | Promise<void>;
  /** Called whenever the catalog status changes. */
  onStatus?: (status: AiGatewayCatalogStatus) => void;
  cacheFilePath?: string;
}): AiGatewayModelCatalogService {
  const cacheFilePath =
    options.cacheFilePath ?? getAiGatewayModelCatalogCacheFilePath();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let refreshPromise: Promise<void> | undefined;
  let retryIndex = 0;
  let disposed = false;
  let hydratedFresh = false;
  let status: AiGatewayCatalogStatus = 'loading';

  const setStatus = (next: AiGatewayCatalogStatus): void => {
    // A catalog has been applied: later failures keep serving it.
    if (status === 'ready' || status === next || disposed) return;
    status = next;
    options.onStatus?.(next);
  };

  const schedule = (delay: number): void => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), delay);
    timer.unref?.();
  };

  const scheduleRetry = (): void => {
    const delay =
      RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] ??
      AI_GATEWAY_MODEL_CATALOG_TTL_MS;
    retryIndex += 1;
    schedule(delay);
  };

  const refresh = async (): Promise<void> => {
    if (disposed || refreshPromise) return refreshPromise;
    refreshPromise = (async (): Promise<void> => {
      setStatus('loading');
      controller = new AbortController();
      let result: Awaited<ReturnType<typeof refreshAiGatewayModelCatalog>>;
      try {
        result = await refreshAiGatewayModelCatalog({
          cacheFilePath,
          serverOrigin: options.serverOrigin,
          brandApiNamespace: options.brandApiNamespace,
          signal: controller.signal,
        });
      } catch (error) {
        result = { status: 'failed', error };
      }
      controller = undefined;
      if (disposed) return;
      if (result.status === 'updated' || result.status === 'not-modified') {
        try {
          await options.onCatalog(result.cache.catalog);
          setStatus('ready');
          retryIndex = 0;
          schedule(AI_GATEWAY_MODEL_CATALOG_TTL_MS);
        } catch {
          // The registry owner retains its previous state when application of
          // a valid response fails. Treat that as a refresh failure so an
          // exception never becomes an unhandled passive-start rejection.
          setStatus('failed');
          scheduleRetry();
        }
        return;
      }
      if (result.status === 'busy') {
        // Another process holds the refresh lock; no attempt failed yet.
        schedule(60_000);
        return;
      }
      setStatus('failed');
      scheduleRetry();
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };

  return {
    async hydrate(): Promise<void> {
      const state = await readAiGatewayModelCatalogCache({
        cacheFilePath,
        serverOrigin: options.serverOrigin,
        brandApiNamespace: options.brandApiNamespace,
      });
      if (state.entry) {
        await options.onCatalog(state.entry.catalog);
        setStatus('ready');
      }
      hydratedFresh = state.freshness === 'fresh';
      if (state.entry && hydratedFresh) {
        const remaining = Math.max(
          0,
          Date.parse(state.entry.fetchedAt) +
            AI_GATEWAY_MODEL_CATALOG_TTL_MS -
            Date.now(),
        );
        schedule(remaining);
      }
    },
    start(): void {
      if (!hydratedFresh) void refresh();
    },
    async retry(): Promise<void> {
      // Only a list that never loaded is retried; a loaded one keeps its TTL
      // and backoff, so a renderer cannot hammer the catalog endpoint.
      if (disposed || status === 'ready') return;
      if (!refreshPromise) {
        retryIndex = 0;
        if (timer) clearTimeout(timer);
        timer = undefined;
      }
      await refresh();
    },
    getStatus(): AiGatewayCatalogStatus {
      return status;
    },
    dispose(): void {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      controller?.abort();
      controller = undefined;
    },
  };
}
