// ---------------------------------------------------------------------------
// "Plugin collections" section rendered inside `PipelineTriggerModal`.
//
// One `PipelinePluginCollectionEditor` is rendered per collection on the
// selected pipeline. The section is hidden entirely when the pipeline declares
// no collections — the trigger modal handles that gating.
// ---------------------------------------------------------------------------

import { type JSX, useMemo } from 'react';
import { PipelinePluginCollectionEditor } from './PipelinePluginCollectionEditor';
import {
  ensureCollectionPreference,
  groupPreviewItemsByCollection,
} from '@/lib/pipelinePluginCollections';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';
import type {
  PipelinePluginCollectionPreference,
  PipelinePluginDefaultPreviewItem,
} from '@canopy/desktop-shared/types/pipeline';

interface PipelinePluginCollectionsSectionProps {
  pipeline: Pipeline;
  previewItems: PipelinePluginDefaultPreviewItem[];
  preferences: Record<string, PipelinePluginCollectionPreference>;
  onPreferencesChange: (
    collectionId: string,
    next: PipelinePluginCollectionPreference,
  ) => void;
}

export function PipelinePluginCollectionsSection({
  pipeline,
  previewItems,
  preferences,
  onPreferencesChange,
}: PipelinePluginCollectionsSectionProps): JSX.Element | null {
  const collections = pipeline.plugin_collections ?? [];
  const itemsByCollection = useMemo(
    () => groupPreviewItemsByCollection(previewItems),
    [previewItems],
  );

  if (collections.length === 0) {
    return null;
  }

  return (
    <section
      className="space-y-1.5"
      data-testid="pipeline-plugin-collections-section"
    >
      <h3 className="text-xs font-medium fg-secondary">Plugin collections</h3>
      <p className="text-xs fg-secondary">
        Workflow defaults are shown with a Workflow badge. Local collections and
        other extras are saved only on this machine.
      </p>

      <div className="space-y-2 pt-1">
        {collections.map((collection) => (
          <PipelinePluginCollectionEditor
            key={collection.id}
            collection={collection}
            previewItems={itemsByCollection[collection.id] ?? []}
            preference={ensureCollectionPreference(preferences, collection.id)}
            onChange={(next) => onPreferencesChange(collection.id, next)}
          />
        ))}
      </div>
    </section>
  );
}
