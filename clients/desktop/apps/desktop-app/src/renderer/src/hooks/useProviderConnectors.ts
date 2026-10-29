import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderConnectorListResult } from '@canopy/desktop-shared/types/mcp-servers';

interface UseProviderConnectorsReturn {
  /**
   * Per-provider reads, or `undefined` until the first one settles.
   *
   * The sentinel is deliberate. Callers used to reconstruct "not attempted
   * yet" from `loading && results.length === 0` and got it wrong — `loading`
   * starts false, so the first render read as "answered: nothing linked",
   * which is the false negative this whole surface keeps reintroducing.
   * Representing it in the data makes that reconstruction impossible rather
   * than merely discouraged.
   */
  results: ProviderConnectorListResult[] | undefined;
  /** True while a read is in flight, so callers can say so. */
  loading: boolean;
  refresh: () => void;
}

/**
 * Suppress a focus-triggered re-read this soon after the last one.
 *
 * Reading Claude's list spawns the CLI, which health-checks every configured
 * server and takes seconds. Without this, every alt-tab back to the app while
 * the Plugins page is open pays that cost again.
 */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 5_000;

/**
 * Read which connectors each agent provider can supply, and which are linked.
 *
 * Linking happens on the provider's own site, so the user leaves the app and
 * comes back. Re-reading on window focus is what makes a connection they just
 * completed show up — but the read is slow enough (seconds, because the CLI
 * health-checks every server) that callers must surface `loading`, or a user
 * who returns to a still-unconnected button concludes it failed.
 */
/**
 * One read shared across every mounted instance, with a short result cache.
 *
 * An in-flight promise alone was not enough. It dedups *concurrent* mounts, but
 * `ChatPluginsModal` is conditionally rendered, so the picker remounts on every
 * open — and each mount then paid a fresh `claude mcp list` (which health-checks
 * every configured MCP server over the network) plus a `JSON.parse` of two
 * Codex caches, the larger measured at ~5 MB, on the Electron main thread.
 *
 * The user-visible cost was the same flash this feature exists to remove,
 * relocated: a linked connector rendered unchecked and then ticked itself
 * seconds later. Serving a recent result synchronously means the second open
 * is correct on first paint.
 *
 * The TTL is deliberately short. Linking happens in a browser and the user
 * comes straight back, so a stale "not linked" must not outlive their return by
 * long; the focus re-read and the explicit refresh both bypass this.
 */
const RESULT_CACHE_TTL_MS = 30_000;

let inFlightRead: Promise<ProviderConnectorListResult[]> | null = null;
let cachedResults: {
  at: number;
  results: ProviderConnectorListResult[];
} | null = null;

function cachedProviderConnectors(): {
  at: number;
  results: ProviderConnectorListResult[];
} | null {
  if (!cachedResults) return null;
  const age = Date.now() - cachedResults.at;
  // A negative age means the clock moved backwards — a system time change, or
  // a suspend/resume. Treating that as "fresh" would pin the entry forever,
  // because it only gets staler by moving further into the past.
  if (age < 0 || age >= RESULT_CACHE_TTL_MS) return null;
  return cachedResults;
}

function readProviderConnectorsShared(): Promise<
  ProviderConnectorListResult[]
> {
  if (inFlightRead) return inFlightRead;
  // Ownership-checked on both writes. `refresh()` disowns the current read by
  // nulling the slot; without these guards the disowned promise would clear a
  // newer one when it settles, and — worse — stamp its own pre-refresh answer
  // into the cache as fresh, serving the stale result to every mount for the
  // rest of the TTL. That is the false negative this whole surface exists to
  // remove, with a propagation window it did not have before the cache.
  const read: Promise<ProviderConnectorListResult[]> = window.mcpServers
    .listProviderConnectors()
    .then((results) => {
      if (inFlightRead === read) cachedResults = { at: Date.now(), results };
      return results;
    })
    .finally(() => {
      if (inFlightRead === read) inFlightRead = null;
    });
  inFlightRead = read;
  return read;
}

/** Drop the cache so the next read goes to the provider. */
function invalidateProviderConnectorCache(): void {
  cachedResults = null;
}

export function useProviderConnectors(
  options: { enabled?: boolean } = {},
): UseProviderConnectorsReturn {
  // Reading Claude spawns a CLI that health-checks every configured server, so
  // callers that will not render connector rows must be able to opt out rather
  // than pay for a result they discard.
  const enabled = options.enabled ?? true;
  const [results, setResults] = useState<
    ProviderConnectorListResult[] | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  // A refresh that arrived while a read was outstanding. Dropping it means the
  // user asked to check again and nothing happened — and the window it lands
  // in is the first second after opening the panel, which is exactly when
  // someone who just linked an account clicks it.
  const refreshQueued = useRef(false);
  const lastReadAt = useRef(0);

  const read = useCallback(
    (options: { allowCache?: boolean } = {}): void => {
      if (!enabled) return;
      // A recent result serves immediately, so a remounted picker is correct on
      // first paint instead of rendering unlinked and ticking itself later.
      // Never on focus: returning to the window is the "I just linked it" signal,
      // and answering that from cache defeats the one flow it exists for.
      const cached =
        options.allowCache === false ? null : cachedProviderConnectors();
      if (cached) {
        setResults(cached.results);
        setLoading(false);
        // Inherit the cached entry's age, not zero. Leaving it at zero told the
        // focus throttle this mount had never read, so the very next focus
        // forced an uncached read — a Claude CLI spawn plus a multi-megabyte
        // JSON.parse on Electron main — on the remount path the cache exists
        // to make free.
        lastReadAt.current = cached.at;
        return;
      }
      // Overlapping reads would race to set state and multiply the CLI spawns
      // for no benefit; the later result is not more current than the pending
      // one by enough to matter — repeated refresh clicks included.
      //
      // A refresh swallowed this way still cannot leave a stale answer behind:
      // it disowns the in-flight promise, and the ownership guard in
      // `readProviderConnectorsShared` stops that promise writing its
      // pre-refresh result into the shared cache. Without that guard the
      // swallowed refresh stamped "not linked" as fresh for the whole TTL, and
      // every later mount was served it.
      if (inFlight.current) {
        // Deduped, not dropped: replayed once the outstanding read settles.
        if (options.allowCache === false) refreshQueued.current = true;
        return;
      }
      inFlight.current = true;
      setLoading(true);
      void readProviderConnectorsShared()
        .then(setResults)
        .catch(() => {
          // A later failure keeps whatever was already read — a stale answer
          // beats an empty one. Only the *first* read has nothing to keep, and
          // leaving it empty is indistinguishable from "the catalog advertises
          // nothing" (the entry builder returns [] for both), which blanked the
          // very list this claimed to preserve. Seeding empty per-provider
          // results there renders the advertised catalog with every route
          // reported as not linked, which is the honest answer.
          setResults((previous) =>
            previous && previous.length > 0
              ? previous
              : [
                  { provider: 'claude', connectors: [] },
                  { provider: 'codex', connectors: [] },
                ],
          );
        })
        .finally(() => {
          inFlight.current = false;
          lastReadAt.current = Date.now();
          setLoading(false);
          if (refreshQueued.current) {
            refreshQueued.current = false;
            // Do not disown here. `refresh()` already disowned the read this
            // is replaying; a read that took the slot since then started
            // *after* the user asked to refresh, so it is exactly the answer
            // they wanted and joining it is correct. Nulling the slot instead
            // released that newer read's claim, and the next mount — finding
            // it empty — spawned a duplicate Claude CLI invocation that
            // health-checks every configured server.
            read({ allowCache: false });
          }
        });
    },
    [enabled],
  );

  useEffect(() => {
    read();
  }, [read]);

  useEffect(() => {
    const handleFocus = (): void => {
      if (Date.now() - lastReadAt.current < FOCUS_REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      read({ allowCache: false });
    };
    window.addEventListener('focus', handleFocus);
    return (): void => window.removeEventListener('focus', handleFocus);
  }, [read]);

  const refresh = useCallback((): void => {
    lastReadAt.current = 0;
    // An explicit refresh must reach the provider — it is the escape hatch for
    // "I just linked this". Serving it from the cache, or joining a read that
    // started before the user linked, would defeat the one action that exists
    // to see a change.
    invalidateProviderConnectorCache();
    inFlightRead = null;
    read({ allowCache: false });
  }, [read]);

  return { results, loading, refresh };
}
