import { useCallback, useEffect, useState } from 'react';
import type {
  DesktopBlueprintCatalogEntry,
  DesktopBlueprintCatalogResponse,
} from '@canopy/desktop-shared/types';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol';

export interface BlueprintCatalogState {
  readonly blueprints: readonly DesktopBlueprintCatalogEntry[];
  readonly sharedTemplates: readonly WorkspaceTemplateShareSummary[];
  readonly loading: boolean;
  /**
   * The cloud could not be reached AND nothing usable was cached, so the
   * catalog is not "verified empty". Surfaces a retry instead of silently
   * showing an empty picker.
   */
  readonly unavailable: boolean;
  /**
   * True once the first read has settled, success or failure. Consumers that
   * must not draw the wrong state while the cache is still being read (the
   * tailored checklist, CAN-3032) wait on this rather than on `loading`,
   * which is false before the read starts as well as after it ends.
   */
  readonly resolved: boolean;
  readonly refresh: () => void;
}

/**
 * Reads the prefetched curated Blueprint catalog (CAN-2964 §6.1).
 *
 * The main process fills the cache during startup background work, long
 * before the create-project modal is reachable, so this is an ordinary IPC
 * read rather than a network fetch: a cold cache degrades to the Empty option
 * instead of blocking the modal. `enabled: false` keeps the hook fully inert
 * so a modal that cannot show the picker never pays for the read.
 */
export function useBlueprintCatalog(enabled: boolean): BlueprintCatalogState {
  const [blueprints, setBlueprints] = useState<
    readonly DesktopBlueprintCatalogEntry[]
  >([]);
  const [sharedTemplates, setSharedTemplates] = useState<
    readonly WorkspaceTemplateShareSummary[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [resolved, setResolved] = useState(false);
  // Bumped by `refresh`, which forces a fresh pull past the staleness gate.
  const [forceKey, setForceKey] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let canceled = false;
    setLoading(true);
    const read = async (): Promise<{
      catalog: DesktopBlueprintCatalogResponse;
      shared: readonly WorkspaceTemplateShareSummary[];
    }> => {
      const [catalog, shared, account] = await Promise.all([
        forceKey === 0
          ? window.api.chatProject.listBlueprints()
          : window.api.chatProject.refreshBlueprints(),
        (
          window.api.chatProject.listSharedTemplates?.() ??
          Promise.resolve({ shares: [] })
        ).catch(() => ({ shares: [] })),
        Promise.resolve(window.api.loadCanopyCloudAccount?.())
          .then((account) => account ?? { account: null })
          .catch(() => ({ account: null })),
      ]);
      const viewerId = account.account?.id;
      return {
        catalog,
        shared: shared.shares.filter(
          (item) =>
            item.audience !== 'PUBLIC' && item.createdBy.id !== viewerId,
        ),
      };
    };
    void read()
      .then(({ catalog, shared }) => {
        if (canceled) return;
        setBlueprints(catalog.blueprints);
        setSharedTemplates(shared);
        // "Verified empty" and "could not reach cloud" are different answers:
        // only the latter earns a retry affordance.
        setUnavailable(
          catalog.available === false &&
            catalog.blueprints.length === 0 &&
            shared.length === 0,
        );
      })
      .catch(() => {
        if (canceled) return;
        setBlueprints([]);
        setSharedTemplates([]);
        setUnavailable(true);
      })
      .finally(() => {
        if (canceled) return;
        setLoading(false);
        setResolved(true);
      });
    return (): void => {
      canceled = true;
    };
  }, [enabled, forceKey]);

  const refresh = useCallback((): void => {
    setForceKey((current) => current + 1);
  }, []);

  return {
    blueprints,
    sharedTemplates,
    loading,
    unavailable,
    resolved,
    refresh,
  };
}
