import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  fetchPinnedHttpGetResponse,
  type PinnedHttpAddress,
} from './pinned-http-fetch';
import { isNonPublicIpAddress } from './network-address';

const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Distinct image URLs held before the least recently used one is dropped.
 *
 * Sized for the working set, not arbitrarily: this cache was written for the
 * curated MCP catalog's few dozen logos, but plugin entries now resolve a
 * publisher avatar PER PLUGIN, which is ~181 distinct owners across a real
 * marketplace catalog. At the old 128 the set no longer fit, so simply
 * browsing evicted and refetched in a loop. Entries are base64 rasters of a
 * couple of KB, so 512 costs on the order of a megabyte and leaves headroom
 * for the catalog to grow.
 */
export const MAX_CACHE_ENTRIES = 512;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const cache = new Map<string, Promise<string | null>>();

async function resolvePublicTarget(
  rawUrl: string,
): Promise<{ url: URL; addresses: PinnedHttpAddress[] } | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address }) => isIP(address) === 0 || isNonPublicIpAddress(address),
    )
  ) {
    return null;
  }
  return {
    url,
    addresses: resolved.map(({ address, family }) => ({
      address,
      family: family === 6 ? 6 : 4,
    })),
  };
}

async function fetchRemoteImage(rawUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let nextUrl = rawUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const target = await resolvePublicTarget(nextUrl);
      if (!target) return null;
      const response = await fetchPinnedHttpGetResponse(
        target.url,
        target.addresses,
        { Accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif' },
        controller.signal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_REDIRECTS) return null;
        try {
          nextUrl = new URL(location, target.url).toString();
        } catch {
          return null;
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const contentType = response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      const contentLength = Number(response.headers.get('content-length'));
      if (
        !contentType ||
        !ALLOWED_IMAGE_TYPES.has(contentType) ||
        (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES)
      ) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.body) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
      if (totalBytes === 0) {
        return null;
      }
      return `data:${contentType};base64,${Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        totalBytes,
      ).toString('base64')}`;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve and cache an untrusted remote image as a renderer-safe data URL. */
export function resolveRemoteImageDataUrl(
  rawUrl: unknown,
): Promise<string | null> {
  if (typeof rawUrl !== 'string' || !rawUrl) return Promise.resolve(null);
  const existing = cache.get(rawUrl);
  if (existing) {
    // Re-insert to mark this key most recently used. A Map iterates in
    // insertion order, so without the delete the eviction below is FIFO: a
    // logo visible on every frame would be dropped purely for having been
    // requested early, then refetched, then dropped again.
    cache.delete(rawUrl);
    cache.set(rawUrl, existing);
    return existing;
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const leastRecentlyUsed = cache.keys().next().value;
    if (leastRecentlyUsed !== undefined) cache.delete(leastRecentlyUsed);
  }
  const pending = fetchRemoteImage(rawUrl);
  cache.set(rawUrl, pending);
  return pending;
}
