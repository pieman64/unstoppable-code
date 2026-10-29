import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/desktop-shared/types/plugins';
import { isBuiltInPluginMarketplaceId } from '@canopy/desktop-shared/types/plugins';
import type {
  UnifiedTableBadge,
  UnifiedTablePipelineDerivedRow,
  UnifiedTableRow,
} from '@/hooks/useUnifiedTableData';
import { parseGitHubRepo } from '@/lib/format';
import { brandText } from '@/lib/brand';
import { normalizeGitHubRepoRef } from '@canopy/desktop-shared/plugin-refs';
import type { EditableCollectionItem } from '@/lib/sharedCollections';

const SHARED_ROW_KEY_PREFIX = '__shared-collection-item__:';

function describePluginMarketplace(
  item: Extract<EditableCollectionItem, { kind: 'external_plugin' }>,
): {
  key: string;
  description: string;
  source: string;
  sourceIcon: 'app' | 'marketplace';
} {
  if (item.marketplace.type === 'builtin') {
    return {
      key: `builtin:${item.marketplace.id}`,
      description: `Built-in plugin: ${item.marketplace.id}`,
      source: `${brandText.appName} (built-in: ${item.marketplace.id})`,
      sourceIcon: 'app',
    };
  }

  return {
    key: `github:${item.marketplace.repo}`,
    description: `Plugin from github:${item.marketplace.repo}`,
    source: `github:${item.marketplace.repo}`,
    sourceIcon: 'marketplace',
  };
}

function findGitHubMarketplace(
  marketplaces: MarketplaceInfo[],
  repo: string,
): MarketplaceInfo | undefined {
  return marketplaces.find((marketplace) => {
    const parsedRepo = parseGitHubRepo(marketplace.sourceUrl);
    if (!parsedRepo) return false;
    return normalizeGitHubRepoRef(parsedRepo) === repo;
  });
}

function buildSharedRowKey(
  item: EditableCollectionItem,
  index: number,
): string {
  switch (item.kind) {
    case 'external_skill': {
      const source =
        item.source.type === 'builtin'
          ? `builtin:${item.source.id}`
          : `github:${item.source.repo}`;
      return `${SHARED_ROW_KEY_PREFIX}skill:${source}:${item.skillName}:${index}`;
    }
    case 'external_plugin': {
      const marketplace = describePluginMarketplace(item);
      return `${SHARED_ROW_KEY_PREFIX}plugin:${marketplace.key}:${item.pluginName}:${index}`;
    }
    case 'linked_custom_skill':
      return `${SHARED_ROW_KEY_PREFIX}linked-custom:${item.skillId}:${index}`;
    case 'draft_custom_skill':
      return `${SHARED_ROW_KEY_PREFIX}draft-custom:${item.clientKey}:${index}`;
  }
}

function findCatalogKeyForItem(
  item: EditableCollectionItem,
  installedSkills: InstalledSkillInfo[],
  marketplaces: MarketplaceInfo[],
): string | null {
  switch (item.kind) {
    case 'external_skill': {
      const matched = installedSkills.find((skill) => {
        if (skill.name !== item.skillName) return false;
        const source = skill.shareableSource;
        if (!source) return false;
        if (item.source.type === 'builtin') {
          return source.type === 'builtin' && source.id === item.source.id;
        }
        return source.type === 'github' && source.repo === item.source.repo;
      });
      return matched ? `${matched.sourceId}/${matched.name}` : null;
    }
    case 'external_plugin': {
      const matchedMarketplace =
        item.marketplace.type === 'builtin'
          ? marketplaces.find(
              (marketplace) =>
                marketplace.builtIn === true ||
                isBuiltInPluginMarketplaceId(marketplace.id),
            )
          : findGitHubMarketplace(marketplaces, item.marketplace.repo);
      if (!matchedMarketplace) return null;
      const matchedPlugin = matchedMarketplace.plugins.find(
        (plugin) => plugin.name === item.pluginName,
      );
      if (!matchedPlugin) return null;
      return `${matchedPlugin.marketplaceId}/${matchedPlugin.name}`;
    }
    case 'draft_custom_skill': {
      const matched = installedSkills.find(
        (skill) =>
          skill.sourceId === 'custom:app' && skill.name === item.skillName,
      );
      return matched ? `${matched.sourceId}/${matched.name}` : null;
    }
    case 'linked_custom_skill':
      return null;
  }
}

function buildSyntheticRow(
  item: EditableCollectionItem,
  index: number,
): UnifiedTablePipelineDerivedRow {
  const key = buildSharedRowKey(item, index);
  const baseBadges: UnifiedTableBadge[] = [];
  if (item.required) {
    baseBadges.push({ label: 'Required', tone: 'danger' });
  }
  baseBadges.push({ label: 'Not installed', tone: 'warning' });

  switch (item.kind) {
    case 'external_skill':
      return {
        rowOrigin: 'pipeline-derived',
        kind: 'skill',
        key,
        name: item.skillName,
        description:
          item.source.type === 'builtin'
            ? `Built-in skill: ${item.source.id}`
            : `Skill from github:${item.source.repo}`,
        source:
          item.source.type === 'builtin'
            ? `${brandText.appName} (built-in: ${item.source.id})`
            : `github:${item.source.repo}`,
        sourceSubtitle: '',
        sourceIcon: item.source.type === 'builtin' ? 'app' : 'repo',
        lastUpdated: '',
        badges: baseBadges,
        toggleMode: 'normal',
        viewDisabled: true,
      };
    case 'external_plugin': {
      const marketplace = describePluginMarketplace(item);
      return {
        rowOrigin: 'pipeline-derived',
        kind: 'plugin',
        key,
        name: item.pluginName,
        description: marketplace.description,
        source: marketplace.source,
        sourceSubtitle: '',
        sourceIcon: marketplace.sourceIcon,
        lastUpdated: '',
        badges: baseBadges,
        toggleMode: 'normal',
        viewDisabled: true,
      };
    }
    case 'linked_custom_skill':
      return {
        rowOrigin: 'pipeline-derived',
        kind: 'skill',
        key,
        name: item.skillName,
        description: `Custom skill hosted on ${brandText.appName} Cloud.`,
        source: `${brandText.appName} Cloud (custom)`,
        sourceSubtitle: '',
        sourceIcon: 'app',
        lastUpdated: '',
        badges: baseBadges,
        toggleMode: 'normal',
        viewDisabled: true,
      };
    case 'draft_custom_skill':
      return {
        rowOrigin: 'pipeline-derived',
        kind: 'skill',
        key,
        name: item.skillName,
        description: 'Custom skill staged for upload.',
        source: `${brandText.appName} (custom)`,
        sourceSubtitle: '',
        sourceIcon: 'app',
        lastUpdated: '',
        badges: baseBadges,
        toggleMode: 'normal',
        viewDisabled: true,
      };
  }
}

export interface SharedCollectionTableMergeInput {
  catalogRows: UnifiedTableRow[];
  items: EditableCollectionItem[];
  installedSkills: InstalledSkillInfo[];
  marketplaces: MarketplaceInfo[];
}

export interface SharedCollectionTableMergeResult {
  rows: UnifiedTableRow[];
  selectedKeys: Set<string>;
  /** Maps the row key shown in the table back to the editable.items index. */
  rowKeyToItemIndex: Map<string, number>;
}

export function mergeSharedItemsWithCatalog(
  input: SharedCollectionTableMergeInput,
): SharedCollectionTableMergeResult {
  const selectedKeys = new Set<string>();
  const rowKeyToItemIndex = new Map<string, number>();
  const itemBadgesByCatalogKey = new Map<string, UnifiedTableBadge[]>();
  const syntheticRows: UnifiedTableRow[] = [];

  input.items.forEach((item, index) => {
    const catalogKey = findCatalogKeyForItem(
      item,
      input.installedSkills,
      input.marketplaces,
    );
    if (catalogKey) {
      selectedKeys.add(catalogKey);
      rowKeyToItemIndex.set(catalogKey, index);
      if (item.required) {
        const existing = itemBadgesByCatalogKey.get(catalogKey) ?? [];
        existing.push({ label: 'Required', tone: 'danger' });
        itemBadgesByCatalogKey.set(catalogKey, existing);
      }
      return;
    }

    const synthetic = buildSyntheticRow(item, index);
    syntheticRows.push(synthetic);
    selectedKeys.add(synthetic.key);
    rowKeyToItemIndex.set(synthetic.key, index);
  });

  const annotatedCatalog = input.catalogRows.map((row) => {
    const extraBadges = itemBadgesByCatalogKey.get(row.key);
    if (!extraBadges) return row;
    const badges = [...(row.badges ?? []), ...extraBadges];
    return { ...row, badges };
  });

  return {
    rows: [...annotatedCatalog, ...syntheticRows],
    selectedKeys,
    rowKeyToItemIndex,
  };
}

export interface BuildItemForRowContext {
  installedSkills: InstalledSkillInfo[];
  marketplaces: MarketplaceInfo[];
  generateClientKey: () => string;
}

/**
 * Build the `EditableCollectionItem` that should be appended when the user
 * checks an unselected catalog row. Returns `null` when the row cannot be
 * expressed as a portable share ref (e.g. local-filesystem skill or an
 * unsupported marketplace).
 */
export function buildItemForCatalogRow(
  row: UnifiedTableRow,
  ctx: BuildItemForRowContext,
): EditableCollectionItem | null {
  if (row.rowOrigin !== 'catalog') return null;
  if (row.kind === 'skill') {
    const skill = row.original as InstalledSkillInfo;
    if (skill.custom === true && skill.sourceId === 'custom:app') {
      return {
        kind: 'draft_custom_skill',
        clientKey: ctx.generateClientKey(),
        localSkillId: `${skill.sourceId}/${skill.name}`,
        skillName: skill.name,
      };
    }
    const source = skill.shareableSource;
    if (!source) return null;
    return {
      kind: 'external_skill',
      source,
      skillName: skill.name,
    };
  }
  if (row.kind === 'plugin') {
    const plugin = row.original as PluginInfo;
    const marketplace = ctx.marketplaces.find(
      (entry) => entry.id === plugin.marketplaceId,
    );
    if (!marketplace) return null;
    if (
      marketplace.builtIn === true ||
      isBuiltInPluginMarketplaceId(marketplace.id)
    ) {
      return {
        kind: 'external_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        pluginName: plugin.name,
      };
    }
    const parsedRepo = parseGitHubRepo(marketplace.sourceUrl);
    if (!parsedRepo) return null;
    return {
      kind: 'external_plugin',
      marketplace: { type: 'github', repo: normalizeGitHubRepoRef(parsedRepo) },
      pluginName: plugin.name,
    };
  }
  return null;
}

export function generateClientKey(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
