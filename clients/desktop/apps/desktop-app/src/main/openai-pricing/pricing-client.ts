import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import {
  parseOpenAiPricingResponse,
  type OpenAiPricingResponseV1,
} from '@canopy/protocol/openai-pricing';
import { requestCanopyCloudPublicJson } from '../canopy-cloud/client';
import { getOpenAiPricingCacheFilePath } from '../lib/paths';

const PRICING_CACHE_TTL_MS = 3_600_000;
const PRICING_PATHNAME = `/api/v1/${BRAND.web.apiNamespace}/openai-pricing`;

export interface OpenAiPricingCacheState {
  payload?: OpenAiPricingResponseV1;
  fetchedAt?: string;
  loadedFrom: 'memory' | 'disk' | 'network' | 'none';
  stale: boolean;
}

interface PersistedOpenAiPricingCache {
  payload: OpenAiPricingResponseV1;
  fetchedAt: string;
}

let memoryCache: PersistedOpenAiPricingCache | undefined;
let diskLoadAttempted = false;
let refreshPromise: Promise<void> | null = null;
let failedRefreshCount = 0;

function nowMs(): number {
  return Date.now();
}

function isFresh(fetchedAt: string): boolean {
  const parsed = Date.parse(fetchedAt);
  return Number.isFinite(parsed) && nowMs() - parsed < PRICING_CACHE_TTL_MS;
}

function stateFromCache(
  cache: PersistedOpenAiPricingCache,
  loadedFrom: OpenAiPricingCacheState['loadedFrom'],
): OpenAiPricingCacheState {
  return {
    payload: cache.payload,
    fetchedAt: cache.fetchedAt,
    loadedFrom,
    stale: !isFresh(cache.fetchedAt),
  };
}

function logRefreshFailure(error: unknown): void {
  failedRefreshCount += 1;
  if (failedRefreshCount !== 1 && failedRefreshCount % 10 !== 0) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OpenAI pricing refresh failed: ${message}\n`);
}

async function readDiskCache(): Promise<
  PersistedOpenAiPricingCache | undefined
> {
  if (diskLoadAttempted) {
    return undefined;
  }
  diskLoadAttempted = true;
  try {
    const raw = await readFile(getOpenAiPricingCacheFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('payload' in parsed) ||
      !('fetchedAt' in parsed) ||
      typeof parsed.fetchedAt !== 'string'
    ) {
      return undefined;
    }
    const payload = parseOpenAiPricingResponse(parsed.payload);
    memoryCache = { payload, fetchedAt: parsed.fetchedAt };
    return memoryCache;
  } catch {
    return undefined;
  }
}

async function writeDiskCache(
  cache: PersistedOpenAiPricingCache,
): Promise<void> {
  const path = getOpenAiPricingCacheFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function refreshFromNetwork(): Promise<PersistedOpenAiPricingCache> {
  const raw = await requestCanopyCloudPublicJson<unknown>(PRICING_PATHNAME, {
    timeoutMs: 10_000,
  });
  const payload = parseOpenAiPricingResponse(raw);
  const cache = { payload, fetchedAt: new Date().toISOString() };
  memoryCache = cache;
  failedRefreshCount = 0;
  await writeDiskCache(cache).catch(() => undefined);
  return cache;
}

function triggerBackgroundRefresh(): void {
  if (refreshPromise) {
    return;
  }
  refreshPromise = refreshFromNetwork()
    .then(() => undefined)
    .catch(logRefreshFailure)
    .finally(() => {
      refreshPromise = null;
    });
}

export async function getOpenAiPricingForCosting(): Promise<OpenAiPricingCacheState> {
  if (memoryCache) {
    const state = stateFromCache(memoryCache, 'memory');
    if (!state.stale) {
      return state;
    }
    triggerBackgroundRefresh();
    return state;
  }

  const diskCache = await readDiskCache();
  if (diskCache) {
    const state = stateFromCache(diskCache, 'disk');
    if (state.stale) {
      triggerBackgroundRefresh();
    }
    return state;
  }

  try {
    return stateFromCache(await refreshFromNetwork(), 'network');
  } catch (error) {
    logRefreshFailure(error);
    return { loadedFrom: 'none', stale: true };
  }
}

export function getOpenAiPricingForCostingSync(): OpenAiPricingCacheState {
  if (!memoryCache) {
    void getOpenAiPricingForCosting();
    return { loadedFrom: 'none', stale: true };
  }
  const state = stateFromCache(memoryCache, 'memory');
  if (state.stale) {
    triggerBackgroundRefresh();
  }
  return state;
}

export function prewarmOpenAiPricingCache(): void {
  void getOpenAiPricingForCosting();
}

export function resetOpenAiPricingCacheForTest(): void {
  memoryCache = undefined;
  diskLoadAttempted = false;
  refreshPromise = null;
  failedRefreshCount = 0;
}
