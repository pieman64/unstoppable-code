import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useState, useEffect, useCallback } from 'react';
import type { CollectionIndexEntry } from '@canopy/desktop-shared/types/collections';

interface UseCollectionListReturn {
  collections: CollectionIndexEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Local Collection index loader. Reads through `window.collections.loadIndex`
 * so the renderer no longer depends on the legacy `BundlesAPI` file-envelope
 * shape. Replaces the historical `useBundleList` hook.
 */
export function useCollectionList(): UseCollectionListReturn {
  const contextEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key),
  );
  const contextGeneration = useWorkspaceContextStore((state) =>
    contextEnabled ? state.appliedGeneration : 0,
  );
  const [collections, setCollections] = useState<CollectionIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (contextEnabled) setCollections([]);
    setLoading(true);
    setError(null);
    try {
      const entries = await window.collections.loadIndex();
      if (
        contextEnabled &&
        useWorkspaceContextStore.getState().appliedGeneration !==
          contextGeneration
      )
        return;
      setCollections(entries);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    } finally {
      setLoading(false);
    }
  }, [contextEnabled, contextGeneration]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    void load();
    return window.installedItems?.onChanged(() => {
      void load();
    });
  }, [load]);

  return { collections, loading, error, refresh };
}
