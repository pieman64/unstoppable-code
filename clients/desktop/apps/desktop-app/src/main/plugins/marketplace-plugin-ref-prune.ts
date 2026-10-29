function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasMarketplaceId(
  value: unknown,
  marketplaceId: string,
): value is { marketplaceId: string } {
  return isRecord(value) && value.marketplaceId === marketplaceId;
}

/**
 * Removes, in place, every `pluginRefs` entry that names `marketplaceId`
 * anywhere in a parsed settings value, and reports whether it removed any.
 * Used when a marketplace is removed, on every file that saves selections.
 */
export function pruneMarketplacePluginRefsFromValue(
  value: unknown,
  marketplaceId: string,
): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    for (const entry of value) {
      changed =
        pruneMarketplacePluginRefsFromValue(entry, marketplaceId) || changed;
    }
    return changed;
  }
  if (!isRecord(value)) {
    return false;
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (key === 'pluginRefs' && Array.isArray(child)) {
      const filtered = child.filter(
        (entry) => !hasMarketplaceId(entry, marketplaceId),
      );
      if (filtered.length !== child.length) {
        value[key] = filtered;
        changed = true;
      }
      continue;
    }
    changed =
      pruneMarketplacePluginRefsFromValue(child, marketplaceId) || changed;
  }
  return changed;
}

/** A copy of the inherited plugin layers in a parsed settings file. */
export function inheritedPluginLayersOf(
  parsed: unknown,
): Record<string, unknown> {
  if (!isRecord(parsed)) return {};
  return structuredClone({
    defaultPluginSelections: parsed.defaultPluginSelections,
    disabledGlobalPluginSelections: parsed.disabledGlobalPluginSelections,
    globalPluginSelections: parsed.globalPluginSelections,
  });
}
