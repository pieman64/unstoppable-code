import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { ClaudeModPluginDetailsTarget } from '@canopy/protocol/claude-mods';
import type { MarketplaceInfo } from '@canopy/execution-engine/types/plugins';
import { entryIdForSelection } from '@/lib/relatedCapabilities';
import { useNavigationStore } from '@/stores/navigationStore';

/** Opens a catalog plugin's entry on the Plugins page, curated ones included. */
export function openClaudeModPluginDetails(
  details: ClaudeModPluginDetailsTarget,
): void {
  void (async (): Promise<void> => {
    let marketplaces: readonly MarketplaceInfo[] = [];
    try {
      const result = await window.plugins.loadMarketplaces();
      if (result.success && result.data) {
        marketplaces = result.data.marketplaces;
      }
    } catch (error) {
      reportClientAppError(error);
      // Without the list, a non-curated entry id is still the right one.
    }
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'entry-detail',
      entryId: entryIdForSelection(
        {
          kind: 'plugin',
          marketplaceId: details.marketplaceId,
          pluginName: details.pluginName,
        },
        marketplaces,
      ),
    });
  })();
}
