// ---------------------------------------------------------------------------
// Renderer-side merging logic for pipeline plugin collections.
//
// The pipeline trigger modal uses these helpers to:
//   - splice synthetic "pipeline-derived" rows into the unified-table catalog
//     for unmatched defaults
//   - badge matched catalog rows with `Pipeline` (and `Required`)
//   - compute `selectedKeys` and per-row `toggleMode` from the current
//     `PipelinePluginCollectionPreference`
//   - apply user toggles back into the preference object
//
// All matching is done by `defaultKey` and `matchedCatalogKey` from the
// `PipelinePluginDefaultPreviewItem` array returned by the
// `resolvePluginCollections` IPC. The renderer never re-derives the matching
// itself — it only consumes the snapshot the main process produced.
// ---------------------------------------------------------------------------

import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { WORKFLOW_ITEM_LABEL } from '@canopy/ui-shared/lib/workflow-labels';
import type {
  PipelineInfo,
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
  PipelinePreferenceLocator,
} from '@canopy/execution-engine/types/pipeline';
import type {
  UnifiedTableBadge,
  UnifiedTablePipelineDerivedRow,
  UnifiedTableRow,
} from '../hooks/useUnifiedTableData';

// ---------------------------------------------------------------------------
// Locator derivation
// ---------------------------------------------------------------------------

/**
 * Derive the canonical `PipelinePreferenceLocator` for a `PipelineInfo`.
 *
 * Project pipelines (loaded from a file in a project's `.canopy/` dir) are
 * keyed by their absolute file path so the same pipeline saved under a
 * different name still maps to the same prefs entry. Shared pipelines
 * (hosted on the singleton Canopy Cloud backend) are keyed by their canonical
 * compound identity `${serverId}:${remoteId}` so saved defaults persist
 * independently per shared pipeline. Bundled and user-stored
 * pipelines also carry their source so same-id entries do not collide.
 *
 * Shared pipelines must NEVER fall back to `file:` — the cached file path
 * is per-execution, so a `file:` locator would point at a path that does
 * not survive past the run.
 */
export function derivePipelinePreferenceLocator(
  info: PipelineInfo,
): PipelinePreferenceLocator {
  if (info.source === 'project' && info.filePath) {
    return { type: 'file', value: info.filePath };
  }
  if (info.source === 'shared' && info.serverId && info.remoteId) {
    return {
      type: 'shared',
      value: `${info.serverId}:${info.remoteId}`,
    };
  }
  if (info.source === 'curated') {
    return {
      type: 'stored',
      source: 'curated',
      value: info.id,
      ...(info.curatedContentHash
        ? { contentHash: info.curatedContentHash }
        : {}),
    };
  }
  if (info.source === 'bundled' || info.source === 'user') {
    return { type: 'stored', source: info.source, value: info.id };
  }
  // Degraded project discoveries can lack filePath; fall back to the stable id.
  return { type: 'file', value: info.id };
}

// ---------------------------------------------------------------------------
// Empty preference factory
// ---------------------------------------------------------------------------

export function createEmptyCollectionPreference(): PipelinePluginCollectionPreference {
  return {
    disabledDefaultKeys: [],
    extraSelections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
  };
}

export function ensureCollectionPreference(
  preferences: Record<string, PipelinePluginCollectionPreference>,
  collectionId: string,
): PipelinePluginCollectionPreference {
  return preferences[collectionId] ?? createEmptyCollectionPreference();
}

// ---------------------------------------------------------------------------
// Catalog ↔ extras key conversion
// ---------------------------------------------------------------------------

/**
 * Build the unique row key used by `useUnifiedTableData` rows for a given
 * "extras" entry. The key shapes mirror those produced inside the hook itself.
 */
export function buildExtraSelectionKeys(
  extras: ChatTabPluginSelections,
): Set<string> {
  const keys = new Set<string>();
  for (const id of extras.collectionIds) {
    keys.add(id);
  }
  for (const ref of extras.skillRefs) {
    keys.add(`${ref.sourceId}/${ref.skillName}`);
  }
  for (const ref of extras.pluginRefs) {
    keys.add(`${ref.marketplaceId}/${ref.pluginName}`);
  }
  for (const ref of extras.mcpServerRefs ?? []) {
    keys.add(`${ref.serverId}/${ref.configId}`);
  }
  return keys;
}

/**
 * Toggle `key` inside an `extraSelections` map, identifying the kind of entry
 * by the row it came from. Returns a new selections object.
 */
export function toggleExtraSelectionKey(
  extras: ChatTabPluginSelections,
  row: UnifiedTableRow,
): ChatTabPluginSelections {
  const next: ChatTabPluginSelections = {
    collectionIds: [...extras.collectionIds],
    skillRefs: [...extras.skillRefs],
    pluginRefs: [...extras.pluginRefs],
    mcpServerRefs: [...(extras.mcpServerRefs ?? [])],
  };

  if (row.kind === 'collection') {
    if (next.collectionIds.includes(row.key)) {
      next.collectionIds = next.collectionIds.filter((id) => id !== row.key);
    } else {
      next.collectionIds = [...next.collectionIds, row.key].sort();
    }
  } else if (row.kind === 'skill') {
    const lastSlash = row.key.lastIndexOf('/');
    const sourceId = row.key.slice(0, lastSlash);
    const skillName = row.key.slice(lastSlash + 1);
    const exists = next.skillRefs.some(
      (ref) => ref.sourceId === sourceId && ref.skillName === skillName,
    );
    next.skillRefs = exists
      ? next.skillRefs.filter(
          (ref) => !(ref.sourceId === sourceId && ref.skillName === skillName),
        )
      : [...next.skillRefs, { sourceId, skillName }];
  } else if (row.kind === 'plugin') {
    const lastSlash = row.key.lastIndexOf('/');
    const marketplaceId = row.key.slice(0, lastSlash);
    const pluginName = row.key.slice(lastSlash + 1);
    const exists = next.pluginRefs.some(
      (ref) =>
        ref.marketplaceId === marketplaceId && ref.pluginName === pluginName,
    );
    next.pluginRefs = exists
      ? next.pluginRefs.filter(
          (ref) =>
            !(
              ref.marketplaceId === marketplaceId &&
              ref.pluginName === pluginName
            ),
        )
      : [...next.pluginRefs, { marketplaceId, pluginName }];
  } else if (row.kind === 'mcp') {
    const slash = row.key.indexOf('/');
    const serverId = row.key.slice(0, slash);
    const configId = row.key.slice(slash + 1);
    const list = next.mcpServerRefs ?? [];
    const exists = list.some(
      (ref) => ref.serverId === serverId && ref.configId === configId,
    );
    next.mcpServerRefs = exists
      ? list.filter(
          (ref) => !(ref.serverId === serverId && ref.configId === configId),
        )
      : [...list, { serverId, configId }];
  }

  return next;
}

// ---------------------------------------------------------------------------
// Row annotation
// ---------------------------------------------------------------------------

/**
 * Build a synthetic `pipeline-derived` row for an unmatched default.
 *
 * Synthetic rows surface unmatched defaults inline in the unified table even
 * though no local catalog item exists for them. These rows always carry a
 * `shareableRef` so the caller can pipe them back through `disabledDefaultKeys`
 * by `defaultKey` (carried in the synthetic row's `key`).
 */
export function buildSyntheticPipelineRow(
  item: PipelinePluginDefaultPreviewItem,
): UnifiedTablePipelineDerivedRow {
  const badges: UnifiedTableBadge[] = [
    { label: WORKFLOW_ITEM_LABEL, tone: 'info' },
  ];
  if (item.required) {
    badges.push({ label: 'Required', tone: 'danger' });
  }
  badges.push({ label: 'Missing', tone: 'warning' });

  return {
    rowOrigin: 'pipeline-derived',
    kind: item.kind === 'plugin' ? 'plugin' : 'skill',
    key: `__pipeline-default__:${item.defaultKey}`,
    name: item.displayName,
    description: item.displayDescription,
    source: item.displaySource,
    sourceSubtitle: item.displaySourceSubtitle ?? '',
    sourceIcon: item.kind === 'plugin' ? 'marketplace' : 'repo',
    lastUpdated: '',
    badges,
    toggleMode: item.required ? 'locked' : 'normal',
    toggleReason: item.required
      ? 'This workflow default is required and cannot be turned off.'
      : item.warning,
    viewDisabled: true,
  };
}

interface AnnotatedRowsResult {
  rows: UnifiedTableRow[];
  /**
   * The `key` of every row that should be shown as "selected" given the
   * current preference snapshot.
   */
  selectedKeys: Set<string>;
  /**
   * Map of `defaultKey -> the row.key` actually used to represent that
   * default, so the toggle handler can locate the right preference state.
   */
  defaultKeyToRowKey: Map<string, string>;
}

/**
 * Annotate `catalogRows` with `Pipeline`/`Required`/`Missing` badges and
 * splice synthetic rows in for unmatched defaults.
 *
 * This produces the row list passed to `<UnifiedTable>` for one collection.
 *
 * Selection rules:
 *  - matched optional default — selected unless its `defaultKey` is in
 *    `preference.disabledDefaultKeys`
 *  - matched required default — always selected, locked
 *  - unmatched optional default — synthetic row, selected unless disabled
 *  - unmatched required default — synthetic row, selected and locked
 *  - extras (Collections/skills/plugins/mcp) — selected when their key is in
 *    `extraSelections`
 */
export function annotateRowsForCollection(
  catalogRows: UnifiedTableRow[],
  items: PipelinePluginDefaultPreviewItem[],
  preference: PipelinePluginCollectionPreference,
): AnnotatedRowsResult {
  const disabledKeys = new Set(preference.disabledDefaultKeys);
  const extraKeys = buildExtraSelectionKeys(preference.extraSelections);
  const selectedKeys = new Set<string>(extraKeys);
  const defaultKeyToRowKey = new Map<string, string>();
  const matchedCatalogKeys = new Set<string>();

  // Index items by matched catalog key (when matched) for O(1) annotation.
  const itemsByCatalogKey = new Map<
    string,
    PipelinePluginDefaultPreviewItem[]
  >();
  const unmatchedItems: PipelinePluginDefaultPreviewItem[] = [];
  for (const item of items) {
    if (item.matchState === 'matched' && item.matchedCatalogKey) {
      const list = itemsByCatalogKey.get(item.matchedCatalogKey);
      if (list) {
        list.push(item);
      } else {
        itemsByCatalogKey.set(item.matchedCatalogKey, [item]);
      }
      matchedCatalogKeys.add(item.matchedCatalogKey);
    } else {
      unmatchedItems.push(item);
    }
  }

  // Annotate matched catalog rows.
  const annotatedRows: UnifiedTableRow[] = catalogRows.map((row) => {
    const matchingItems = itemsByCatalogKey.get(row.key);
    if (!matchingItems || matchingItems.length === 0) {
      return row;
    }

    const required = matchingItems.some((item) => item.required);
    const badges: UnifiedTableBadge[] = [
      ...(row.badges ?? []),
      { label: WORKFLOW_ITEM_LABEL, tone: 'info' },
    ];
    if (required) {
      badges.push({ label: 'Required', tone: 'danger' });
    }

    // Selection: required = always on; optional = on unless every matching
    // default is disabled. (Matching is rare-many so "every" is the safer
    // semantic — if any matching default still wants it, keep it on.)
    const isAnyEnabled = matchingItems.some(
      (item) => !disabledKeys.has(item.defaultKey),
    );
    const isSelected = required ? true : isAnyEnabled;

    if (isSelected) {
      selectedKeys.add(row.key);
    }
    for (const item of matchingItems) {
      defaultKeyToRowKey.set(item.defaultKey, row.key);
    }

    return {
      ...row,
      badges,
      toggleMode: required ? 'locked' : (row.toggleMode ?? 'normal'),
      toggleReason: required
        ? 'This workflow default is required and cannot be turned off.'
        : row.toggleReason,
    };
  });

  // Splice synthetic rows in for unmatched defaults.
  for (const item of unmatchedItems) {
    const synthetic = buildSyntheticPipelineRow(item);
    annotatedRows.push(synthetic);
    defaultKeyToRowKey.set(item.defaultKey, synthetic.key);

    const isSelected = item.required
      ? true
      : !disabledKeys.has(item.defaultKey);
    if (isSelected) {
      selectedKeys.add(synthetic.key);
    }
  }

  return { rows: annotatedRows, selectedKeys, defaultKeyToRowKey };
}

// ---------------------------------------------------------------------------
// Toggle application
// ---------------------------------------------------------------------------

interface ApplyToggleArgs {
  row: UnifiedTableRow;
  items: PipelinePluginDefaultPreviewItem[];
  preference: PipelinePluginCollectionPreference;
  /** Currently-selected keys (computed by `annotateRowsForCollection`). */
  selectedKeys: Set<string>;
}

/**
 * Apply a user toggle on `row`, returning a fresh
 * `PipelinePluginCollectionPreference` for the affected collection.
 *
 * Behavior:
 *  - matched default row — toggling off adds every matching default key to
 *    `disabledDefaultKeys`; toggling on removes them
 *  - synthetic default row — toggling off adds its `defaultKey`; toggling on
 *    removes it
 *  - any other catalog row — adds/removes the row from `extraSelections`
 *  - required defaults are no-ops (the UI already locks the checkbox)
 */
export function applyToggleForCollection(
  args: ApplyToggleArgs,
): PipelinePluginCollectionPreference {
  const { row, items, preference, selectedKeys } = args;

  // Ignore toggles on locked rows entirely.
  if (row.toggleMode === 'locked' || row.toggleMode === 'disabled') {
    return preference;
  }

  // Synthetic pipeline-derived row.
  if (row.rowOrigin === 'pipeline-derived') {
    const defaultKey = row.key.startsWith('__pipeline-default__:')
      ? row.key.slice('__pipeline-default__:'.length)
      : null;
    if (!defaultKey) {
      return preference;
    }
    const wasSelected = selectedKeys.has(row.key);
    const nextDisabled = new Set(preference.disabledDefaultKeys);
    if (wasSelected) {
      nextDisabled.add(defaultKey);
    } else {
      nextDisabled.delete(defaultKey);
    }
    return {
      ...preference,
      disabledDefaultKeys: Array.from(nextDisabled).sort(),
    };
  }

  // Matched catalog row — find every default that matches this row.
  const matchingItems = items.filter(
    (item) =>
      item.matchState === 'matched' && item.matchedCatalogKey === row.key,
  );

  if (matchingItems.length > 0) {
    const wasSelected = selectedKeys.has(row.key);
    const nextDisabled = new Set(preference.disabledDefaultKeys);
    for (const item of matchingItems) {
      if (item.required) continue;
      if (wasSelected) {
        nextDisabled.add(item.defaultKey);
      } else {
        nextDisabled.delete(item.defaultKey);
      }
    }
    return {
      ...preference,
      disabledDefaultKeys: Array.from(nextDisabled).sort(),
    };
  }

  // Plain catalog row — toggle in/out of extras.
  return {
    ...preference,
    extraSelections: toggleExtraSelectionKey(preference.extraSelections, row),
  };
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/**
 * Group preview items by their `collectionId`.
 */
export function groupPreviewItemsByCollection(
  items: PipelinePluginDefaultPreviewItem[],
): Record<string, PipelinePluginDefaultPreviewItem[]> {
  const out: Record<string, PipelinePluginDefaultPreviewItem[]> = {};
  for (const item of items) {
    const list = out[item.collectionId];
    if (list) {
      list.push(item);
    } else {
      out[item.collectionId] = [item];
    }
  }
  return out;
}
