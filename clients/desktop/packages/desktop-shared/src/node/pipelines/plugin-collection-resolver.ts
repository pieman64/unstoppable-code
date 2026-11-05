import type {
  PipelinePluginCollectionPreference,
  ResolvedPipelinePluginCollectionSnapshot,
} from '../../types/pipeline';

export interface PipelinePluginCollectionResolution {
  snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot>;
}

export async function resolvePipelinePluginCollections(
  collections: Array<{ id: string }>,
  preferences: Record<string, PipelinePluginCollectionPreference>,
): Promise<PipelinePluginCollectionResolution> {
  await Promise.resolve();
  const snapshots: Record<string, ResolvedPipelinePluginCollectionSnapshot> =
    {};
  for (const collection of collections) {
    snapshots[collection.id] = {
      selections: preferences[collection.id]?.extraSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      chatSelections: preferences[collection.id]?.extraSelections ?? {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      sourceCollectionIds:
        preferences[collection.id]?.extraSelections.collectionIds ?? [],
      missingOptionalDefaults: [],
      unresolvedRequiredDefaults: [],
    };
  }
  return { snapshots };
}
