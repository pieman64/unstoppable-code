import { useCallback, useEffect, useState } from 'react';
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';

interface UseCuratedMcpServersReturn {
  /** Curated catalog entries; empty when the catalog is unavailable. */
  entries: CuratedMcpServerEntry[];
  /** True while enabled and the initial (or a forced) load is in flight. */
  loading: boolean;
  /** Non-fatal error message from the last load, if any. */
  error: string | null;
  /**
   * Force a re-fetch from Canopy Web, bypassing any cached copy. Resolves to
   * the entries it loaded, empty when the catalog is unavailable.
   */
  refresh: () => Promise<CuratedMcpServerEntry[]>;
}

/**
 * Reads the brand-scoped curated MCP server catalog served by the desktop main
 * process. Deliberately resilient: any transport failure (no backend handler
 * registered, network error, malformed payload) degrades to an EMPTY catalog
 * so the MCP Servers toolbar falls back to the plain "Add Custom" affordance
 * rather than erroring. Consumers gate the browse UX on `entries.length > 0`.
 */
export function useCuratedMcpServers(
  options: { enabled?: boolean } = {},
): UseCuratedMcpServersReturn {
  // Callers that will not render curated rows should not pay the catalog IPC.
  const enabled = options.enabled ?? true;
  const [entries, setEntries] = useState<CuratedMcpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (forceRefresh: boolean): Promise<CuratedMcpServerEntry[]> => {
      if (!enabled) {
        setLoading(false);
        return [];
      }
      setLoading(true);
      setError(null);
      try {
        const response = forceRefresh
          ? await window.mcpServers.refreshCurated()
          : await window.mcpServers.listCurated();
        const loaded = response?.servers ?? [];
        setEntries(loaded);
        return loaded;
      } catch (err) {
        // Empty catalog is the intended degraded state — surface the message for
        // diagnostics but keep the UI usable.
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
        return [];
      } finally {
        setLoading(false);
        setLoaded(true);
      }
    },
    [enabled],
  );

  const refresh = useCallback(
    (): Promise<CuratedMcpServerEntry[]> => load(true),
    [load],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Turning the read on renders once before its effect starts the load; that
  // render must not read as a loaded, empty catalog.
  return {
    entries,
    loading: enabled && (loading || !loaded),
    error,
    refresh,
  };
}
