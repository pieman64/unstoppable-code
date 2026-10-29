import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { useMarketplaceList } from '../../hooks/useMarketplaceList';
import type { UnifiedTableRow } from '../../hooks/useUnifiedTableData';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';

export interface SkillDetailSelection {
  sourceId: string;
  name: string;
}

interface UnifiedTableDetailActions {
  setViewingCollectionId?: Dispatch<SetStateAction<string | null>>;
  setViewingSkill: Dispatch<SetStateAction<SkillDetailSelection | null>>;
  setViewingPlugin: Dispatch<SetStateAction<PluginInfo | null>>;
  setViewingMcpServerId: Dispatch<SetStateAction<string | null>>;
  setViewingMcpConfigId: Dispatch<SetStateAction<string | null>>;
}

export interface UnifiedTableDetailView extends UnifiedTableDetailActions {
  viewingSkill: SkillDetailSelection | null;
  viewingPlugin: PluginInfo | null;
  viewingPluginMarketplace: MarketplaceInfo | null;
  viewingMcpServerId: string | null;
  /** The configuration the opened MCP row names, for account servers. */
  viewingMcpConfigId: string | null;
  openRowDetails: (row: UnifiedTableRow) => void;
  closeDetails: () => void;
}

function pluginInfoFromRow(row: UnifiedTableRow): PluginInfo | null {
  if (row.rowOrigin !== 'catalog' || row.kind !== 'plugin') return null;
  const { original } = row;
  if (!('marketplaceId' in original)) return null;
  return original;
}

function openUnifiedTableRowDetails(
  row: UnifiedTableRow,
  actions: UnifiedTableDetailActions,
): void {
  if (row.kind === 'collection') {
    actions.setViewingCollectionId?.(row.key);
  } else if (row.kind === 'skill') {
    const lastSlash = row.key.lastIndexOf('/');
    actions.setViewingSkill({
      sourceId: row.key.slice(0, lastSlash),
      name: row.key.slice(lastSlash + 1),
    });
  } else if (row.kind === 'plugin') {
    const plugin = pluginInfoFromRow(row);
    if (plugin) actions.setViewingPlugin(plugin);
  } else if (row.kind === 'mcp') {
    // Account rows for one key share the server id, so the configuration
    // decides which connection opens.
    const slash = row.key.indexOf('/');
    actions.setViewingMcpConfigId(row.key.slice(slash + 1) || null);
    actions.setViewingMcpServerId(row.key.slice(0, slash));
  }
}

export function useUnifiedTableDetailView(
  setViewingCollectionId?: Dispatch<SetStateAction<string | null>>,
): UnifiedTableDetailView {
  const [viewingSkill, setViewingSkill] = useState<SkillDetailSelection | null>(
    null,
  );
  const [viewingPlugin, setViewingPlugin] = useState<PluginInfo | null>(null);
  const [viewingMcpServerId, setViewingMcpServerId] = useState<string | null>(
    null,
  );
  const [viewingMcpConfigId, setViewingMcpConfigId] = useState<string | null>(
    null,
  );
  const { cache } = useMarketplaceList();

  const viewingPluginMarketplace = useMemo(
    () =>
      viewingPlugin
        ? ((cache?.marketplaces ?? []).find(
            (marketplace) => marketplace.id === viewingPlugin.marketplaceId,
          ) ?? null)
        : null,
    [viewingPlugin, cache?.marketplaces],
  );

  const closeDetails = useCallback((): void => {
    setViewingMcpServerId(null);
    setViewingMcpConfigId(null);
    setViewingPlugin(null);
    setViewingSkill(null);
    setViewingCollectionId?.(null);
  }, [setViewingCollectionId]);

  const openRowDetails = useCallback(
    (row: UnifiedTableRow): void =>
      openUnifiedTableRowDetails(row, {
        setViewingCollectionId,
        setViewingSkill,
        setViewingPlugin,
        setViewingMcpServerId,
        setViewingMcpConfigId,
      }),
    [setViewingCollectionId],
  );

  return {
    setViewingCollectionId,
    viewingSkill,
    setViewingSkill,
    viewingPlugin,
    setViewingPlugin,
    viewingPluginMarketplace,
    viewingMcpServerId,
    setViewingMcpServerId,
    viewingMcpConfigId,
    setViewingMcpConfigId,
    openRowDetails,
    closeDetails,
  };
}
