import { useEffect, useState } from 'react';

const resolvedImages = new Map<string, Promise<string | null>>();

/**
 * Distinct image URLs memoized before the least recently used one is dropped.
 *
 * Matches `MAX_CACHE_ENTRIES` in the main-process cache this delegates to, and
 * sized for the same reason: per-plugin publisher avatars put ~181 distinct
 * owners in the working set, which no longer fit the original 128. A miss here
 * is cheaper than a miss there — it costs an IPC round-trip rather than a
 * network fetch, because main answers from its own cache — but it still
 * re-renders the tile through a null state, so the two are kept in step.
 */
const MAX_RESOLVED_IMAGES = 512;

/** Accept only inert image data URLs returned by the main-process cache. */
export function safeRemoteImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  return /^data:image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/]+=*$/i.test(
    value,
  )
    ? value
    : null;
}

/** Resolve an untrusted image without allowing the renderer to request it. */
export function useSafeRemoteImageUrl(
  value: string | undefined,
): string | null {
  const [safeUrl, setSafeUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSafeUrl(null);
    if (!value || !window.mcpServers?.resolveRemoteImage) return;
    let pending = resolvedImages.get(value);
    if (pending) {
      // Re-insert to mark this key most recently used; a Map iterates in
      // insertion order, so without this the eviction below is FIFO and drops
      // entries for being old rather than for being unused.
      resolvedImages.delete(value);
      resolvedImages.set(value, pending);
    } else {
      if (resolvedImages.size >= MAX_RESOLVED_IMAGES) {
        const leastRecentlyUsed = resolvedImages.keys().next().value;
        if (leastRecentlyUsed !== undefined) {
          resolvedImages.delete(leastRecentlyUsed);
        }
      }
      // Wrapped rather than `.catch`ed directly: the bridge is only known to
      // EXIST from the guard above, not to return a thenable. A preload that
      // hands back anything else would otherwise throw inside this effect and
      // take the surrounding tree down, which is a steep price for a decorative
      // image. `Promise.resolve` passes a real promise through untouched.
      pending = Promise.resolve(window.mcpServers.resolveRemoteImage(value))
        .then((resolved) => resolved ?? null)
        .catch(() => null);
      resolvedImages.set(value, pending);
    }
    void pending.then((resolved) => {
      if (!cancelled) setSafeUrl(safeRemoteImageUrl(resolved ?? undefined));
    });
    return (): void => {
      cancelled = true;
    };
  }, [value]);
  return safeUrl;
}
