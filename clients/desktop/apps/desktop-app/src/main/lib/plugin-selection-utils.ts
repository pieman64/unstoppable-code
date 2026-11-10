import { mcpHttpAuthTargetKey } from '@canopy/execution-engine/lib/mcp-http-auth';
import {
  hasAnySelections,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';

export function mergePluginSelections(
  base: ChatTabPluginSelections | undefined,
  extra: ChatTabPluginSelections,
): ChatTabPluginSelections | undefined {
  const mcpHttpAuthPreferences = new Map(
    (base?.mcpHttpAuthPreferences ?? []).map((entry) => [
      mcpHttpAuthTargetKey(entry.target),
      entry,
    ]),
  );
  for (const entry of extra.mcpHttpAuthPreferences ?? []) {
    mcpHttpAuthPreferences.set(mcpHttpAuthTargetKey(entry.target), entry);
  }

  // Source `collectionIds` from the new canonical field first, falling back
  // to the deprecated `bundleIds` alias for callers that haven't migrated yet.
  const baseCollectionIds: string[] = [
    ...(base?.collectionIds ?? []),
    ...(base?.bundleIds ?? []),
  ];
  const dedupedCollectionIds: string[] = [];
  const seenCollectionIds = new Set<string>();
  for (const id of baseCollectionIds) {
    if (!id || seenCollectionIds.has(id)) continue;
    seenCollectionIds.add(id);
    dedupedCollectionIds.push(id);
  }

  const merged: ChatTabPluginSelections = {
    collectionIds: dedupedCollectionIds,
    skillRefs: [...(base?.skillRefs ?? [])],
    pluginRefs: [...(base?.pluginRefs ?? [])],
    mcpServerRefs: [...(base?.mcpServerRefs ?? [])],
    mcpHttpAuthPreferences: Array.from(mcpHttpAuthPreferences.values()),
  };

  for (const id of extra.collectionIds ?? []) {
    if (!id || seenCollectionIds.has(id)) continue;
    seenCollectionIds.add(id);
    merged.collectionIds.push(id);
  }

  for (const ref of extra.skillRefs) {
    if (
      !merged.skillRefs.some(
        (entry) =>
          entry.sourceId === ref.sourceId && entry.skillName === ref.skillName,
      )
    ) {
      merged.skillRefs.push(ref);
    }
  }
  for (const ref of extra.pluginRefs) {
    if (
      !merged.pluginRefs.some(
        (entry) =>
          entry.marketplaceId === ref.marketplaceId &&
          entry.pluginName === ref.pluginName,
      )
    ) {
      merged.pluginRefs.push(ref);
    }
  }
  for (const ref of extra.mcpServerRefs ?? []) {
    if (
      !merged.mcpServerRefs?.some(
        (entry) =>
          entry.serverId === ref.serverId && entry.configId === ref.configId,
      )
    ) {
      merged.mcpServerRefs = merged.mcpServerRefs ?? [];
      merged.mcpServerRefs.push(ref);
    }
  }

  return hasAnySelections(merged) ? merged : undefined;
}
