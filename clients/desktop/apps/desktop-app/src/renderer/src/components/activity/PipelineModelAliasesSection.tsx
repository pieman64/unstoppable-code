// ---------------------------------------------------------------------------
// "Model Aliases" section rendered inside `PipelineTriggerModal` (and reused by
// dispatch + the `worktree_pipeline` automation setup). One
// `PipelineModelAliasEditor` is rendered per alias declared on the pipeline.
//
// This is a PEER of the plugin-collections section — not folded into a plugin
// collection row. It is hidden entirely when the pipeline declares no aliases.
// ---------------------------------------------------------------------------

import { type JSX } from 'react';
import type {
  PipelineModelAlias,
  PipelineModelAliasPreference,
  PipelinePluginCollection,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineModelAliasEditor } from './PipelineModelAliasEditor';

interface PipelineModelAliasesSectionProps {
  aliases: PipelineModelAlias[];
  preferences: Record<string, PipelineModelAliasPreference>;
  pluginCollections: PipelinePluginCollection[];
  onPreferenceChange: (
    aliasId: string,
    next: PipelineModelAliasPreference | undefined,
  ) => void;
  readonly?: boolean;
}

export function PipelineModelAliasesSection({
  aliases,
  preferences,
  pluginCollections,
  onPreferenceChange,
  readonly = false,
}: PipelineModelAliasesSectionProps): JSX.Element | null {
  if (aliases.length === 0) {
    return null;
  }

  return (
    <section
      className="space-y-1.5"
      data-testid="pipeline-model-aliases-section"
    >
      <label className="text-xs font-medium fg-secondary ">Model aliases</label>
      <p className="text-xs fg-secondary">
        Choose the model alias values agent steps will use. Pipeline defaults
        are used as the baseline when available.
      </p>

      <div className="space-y-2 pt-1">
        {aliases.map((alias) => (
          <PipelineModelAliasEditor
            key={alias.id}
            alias={alias}
            preference={preferences[alias.id]}
            pluginCollections={pluginCollections}
            onChange={(next) => onPreferenceChange(alias.id, next)}
            readonly={readonly}
          />
        ))}
      </div>
    </section>
  );
}
