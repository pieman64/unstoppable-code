import { readFile } from 'node:fs/promises';
import {
  isAiGatewayModelCatalogResponse,
  parseAiGatewayModelCatalogResponse,
  type AiGatewayModelCatalogResponse,
} from '@canopy/protocol/ai-gateway-models';

/**
 * Bumped with each catalog wire-shape change. Versions 6 and 7 can be promoted:
 * version 7 only adds optional Cursor metadata and version 8 only widens
 * `family` to any registry key. v9 adds optional exact-thinking metadata; v8
 * caches are promoted stale with their representation ETag discarded. v10 adds
 * optional image capability; v9 caches likewise promote without granting images.
 * Older incompatible shapes expire.
 */
export const AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION = 10 as const;
const PROMOTABLE_CACHE_VERSIONS = new Set<unknown>([6, 7, 8, 9]);
export const AI_GATEWAY_MODEL_CATALOG_TTL_MS = 15 * 60 * 1000;

export interface AiGatewayModelCatalogCacheFile {
  cacheVersion: typeof AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION;
  serverOrigin: string;
  brandApiNamespace: string;
  fetchedAt: string;
  etag?: string;
  catalog: AiGatewayModelCatalogResponse;
}

export interface AiGatewayModelCatalogCacheState {
  entry?: AiGatewayModelCatalogCacheFile;
  freshness: 'fresh' | 'stale' | 'missing';
}

export function normalizeAiGatewayCatalogServerOrigin(input: string): string {
  const url = new URL(input.trim());
  return url.origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAiGatewayModelCatalogCacheFile(
  value: unknown,
  expected: { serverOrigin: string; brandApiNamespace: string },
): value is AiGatewayModelCatalogCacheFile {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    !keys.every((key) =>
      [
        'cacheVersion',
        'serverOrigin',
        'brandApiNamespace',
        'fetchedAt',
        'etag',
        'catalog',
      ].includes(key),
    ) ||
    value.cacheVersion !== AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION ||
    value.serverOrigin !==
      normalizeAiGatewayCatalogServerOrigin(expected.serverOrigin) ||
    value.brandApiNamespace !== expected.brandApiNamespace ||
    typeof value.fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.fetchedAt)) ||
    (value.etag !== undefined && typeof value.etag !== 'string') ||
    !isAiGatewayModelCatalogResponse(value.catalog)
  ) {
    return false;
  }
  return true;
}

export async function readAiGatewayModelCatalogCache(options: {
  cacheFilePath: string;
  serverOrigin: string;
  brandApiNamespace: string;
  now?: () => number;
  readText?: (path: string) => Promise<string>;
}): Promise<AiGatewayModelCatalogCacheState> {
  const readText =
    options.readText ??
    ((path: string): Promise<string> => readFile(path, 'utf8'));
  try {
    const text = await readText(options.cacheFilePath);
    let raw: unknown = JSON.parse(text);
    const migrating =
      isRecord(raw) &&
      PROMOTABLE_CACHE_VERSIONS.has(raw.cacheVersion) &&
      isRecord(raw.catalog) &&
      raw.catalog.version === raw.cacheVersion;
    if (migrating && isRecord(raw)) {
      raw = {
        ...raw,
        cacheVersion: AI_GATEWAY_MODEL_CATALOG_CACHE_VERSION,
        catalog: parseAiGatewayModelCatalogResponse(raw.catalog),
        etag: undefined,
      };
    }
    if (
      !isAiGatewayModelCatalogCacheFile(raw, {
        serverOrigin: options.serverOrigin,
        brandApiNamespace: options.brandApiNamespace,
      })
    ) {
      return { freshness: 'missing' };
    }
    const age = (options.now ?? Date.now)() - Date.parse(raw.fetchedAt);
    return {
      entry: raw,
      freshness:
        !migrating && age >= 0 && age < AI_GATEWAY_MODEL_CATALOG_TTL_MS
          ? 'fresh'
          : 'stale',
    };
  } catch {
    return { freshness: 'missing' };
  }
}
