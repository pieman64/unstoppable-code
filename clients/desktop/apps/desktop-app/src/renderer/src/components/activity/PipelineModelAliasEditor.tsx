// ---------------------------------------------------------------------------
// Per-alias editor used by `PipelineModelAliasesSection`.
//
// Renders a single `PipelineModelAlias` as a collapsible card that lets the
// user customize the model choice for a run (inline model or a local Agent),
// reset to the pipeline defaults, or clear a custom value. Reset/clear always
// write a `{ mode: 'reset' }` marker — never a key deletion — so a stored
// per-pipeline preference can be forced back to the pipeline default (see the
// reset tombstone contract).
// ---------------------------------------------------------------------------

import { useMemo, useState, type JSX } from 'react';
import type {
  PipelineModelAlias,
  PipelineModelAliasPreference,
  PipelinePluginCollection,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getAgentModelAvailability,
  getModelDisplayName,
} from '@canopy/desktop-shared/types';
import { ModelPicker } from '@/components/chat/ModelPicker';
import { useAgentsStore } from '@/stores/agentsStore';
import { FormField } from '@/components/pipeline/shared/FormField';
import { TextAreaField } from '@/components/pipeline/shared/TextAreaField';
import { SelectField } from '@/components/pipeline/shared/SelectField';
import {
  resolveEffectiveAliasPreference,
  validateEffectiveAliasPreference,
} from '@/lib/pipelineModelAliases';
import { ChevronIcon } from '@canopy/ui-shared/icons';
import { Button, SegmentedControl } from '@canopy/ui-shared/components';

interface PipelineModelAliasEditorProps {
  alias: PipelineModelAlias;
  preference: PipelineModelAliasPreference | undefined;
  pluginCollections: PipelinePluginCollection[];
  onChange: (next: PipelineModelAliasPreference | undefined) => void;
  readonly?: boolean;
}

export function PipelineModelAliasEditor({
  alias,
  preference,
  pluginCollections,
  onChange,
  readonly = false,
}: PipelineModelAliasEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const agents = useAgentsStore((s) => s.agents);
  const availableAgentIds = useMemo(
    () =>
      new Set(
        agents
          .filter((agent) => getAgentModelAvailability(agent.id).available)
          .map((agent) => agent.id),
      ),
    [agents],
  );

  const hasDefaults = alias.defaults !== undefined;

  const effective = useMemo(
    () => resolveEffectiveAliasPreference(alias, undefined, preference),
    [alias, preference],
  );

  const validationError = useMemo(() => {
    const ctx = {
      pluginCollectionIds: new Set(pluginCollections.map((c) => c.id)),
      availableAgentIds,
    };
    return validateEffectiveAliasPreference(effective, ctx);
  }, [effective, pluginCollections, availableAgentIds]);

  const currentMode: 'inline' | 'agent' | null = effective.preference
    ? effective.preference.mode
    : null;

  const subtitle = useMemo(() => {
    if (!effective.preference) {
      return `${alias.id} · Required`;
    }
    if (effective.preference.mode === 'agent') {
      return `${alias.id} · ${effective.preference.agent_id || 'Agent'}`;
    }
    const base = effective.preference.base;
    return `${alias.id} · ${base ? getModelDisplayName(base) : 'No base model'}`;
  }, [alias.id, effective.preference]);

  function selectMode(mode: 'inline' | 'agent'): void {
    if (mode === 'inline') {
      const base =
        effective.preference?.mode === 'inline'
          ? effective.preference.base
          : '';
      const instructions =
        effective.preference?.mode === 'inline'
          ? effective.preference.instructions
          : undefined;
      const pluginCollectionId =
        effective.preference?.mode === 'inline'
          ? effective.preference.plugin_collection_id
          : undefined;
      onChange({
        mode: 'inline',
        base,
        ...(instructions !== undefined && instructions !== ''
          ? { instructions }
          : {}),
        ...(pluginCollectionId !== undefined && pluginCollectionId !== ''
          ? { plugin_collection_id: pluginCollectionId }
          : {}),
      });
      return;
    }
    const agentId =
      effective.preference?.mode === 'agent'
        ? effective.preference.agent_id
        : agents.find((agent) => availableAgentIds.has(agent.id))?.id ||
          agents[0]?.id ||
          '';
    onChange({ mode: 'agent', agent_id: agentId });
  }

  function updateInline(patch: {
    base?: string;
    instructions?: string;
    plugin_collection_id?: string;
  }): void {
    const current =
      effective.preference?.mode === 'inline'
        ? effective.preference
        : { mode: 'inline' as const, base: '' };
    const merged = {
      mode: 'inline' as const,
      base: patch.base ?? current.base,
      instructions: patch.instructions ?? current.instructions,
      plugin_collection_id:
        patch.plugin_collection_id ?? current.plugin_collection_id,
    };
    onChange({
      mode: 'inline',
      base: merged.base,
      ...(merged.instructions !== undefined && merged.instructions !== ''
        ? { instructions: merged.instructions }
        : {}),
      ...(merged.plugin_collection_id !== undefined &&
      merged.plugin_collection_id !== ''
        ? { plugin_collection_id: merged.plugin_collection_id }
        : {}),
    });
  }

  function handleResetOrClear(): void {
    // Both reset-to-defaults and clear-custom-value write a reset tombstone so
    // a stored per-pipeline preference cannot silently reapply.
    onChange({ mode: 'reset' });
  }

  const contentId = `pipeline-model-alias-${alias.id}-content`;

  return (
    <div
      className="rounded-lg border bg-fg-primary/[0.02]"
      data-testid={`pipeline-model-alias-${alias.id}`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-fg-primary/[0.04]"
      >
        <span className="mt-0.5 fg-secondary">
          <ChevronIcon open={expanded} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-s font-medium fg-primary">
              {alias.name || alias.id}
            </span>
            {effective.customized && (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium leading-none bg-accent-subtle fg-accent"
                data-testid={`pipeline-model-alias-${alias.id}-customized`}
              >
                Customized
              </span>
            )}
            {!effective.customized && effective.source === 'default' && (
              <span className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium leading-none bg-fg-primary/10 fg-secondary">
                Workflow default
              </span>
            )}
            {effective.required && (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium leading-none bg-destructive-subtle fg-destructive"
                data-testid={`pipeline-model-alias-${alias.id}-required`}
              >
                Required
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs fg-secondary">
            {subtitle}
          </span>
        </span>
      </button>

      {expanded && (
        <div id={contentId} className="space-y-3 border-t p-3">
          <SegmentedControl
            label="Alias mode"
            shape="capsule"
            width="content"
            value={currentMode}
            disabled={readonly}
            onChange={selectMode}
            options={(['inline', 'agent'] as const).map((mode) => ({
              value: mode,
              label: mode === 'inline' ? 'Inline model' : 'Agent',
              dataTestId: `pipeline-model-alias-${alias.id}-mode-${mode}`,
            }))}
          />

          {currentMode === 'inline' && (
            <div className="space-y-3">
              <FormField label="Base model">
                <div className="flex items-center rounded-md border bg-base px-2 py-1.5">
                  <ModelPicker
                    currentModel={
                      effective.preference?.mode === 'inline'
                        ? effective.preference.base || ''
                        : ''
                    }
                    onModelChange={(model) => updateInline({ base: model })}
                    allowWorkspaceDefault={false}
                    hideAgents
                    disabled={readonly}
                    placeholderLabel="Choose a model"
                    triggerTooltip="Model this alias resolves to"
                  />
                </div>
              </FormField>
              <FormField label="Instructions">
                <TextAreaField
                  value={
                    effective.preference?.mode === 'inline'
                      ? (effective.preference.instructions ?? '')
                      : ''
                  }
                  onChange={(e) =>
                    updateInline({ instructions: e.target.value })
                  }
                  rows={4}
                  placeholder="Instructions appended when this alias is used…"
                  disabled={readonly}
                />
              </FormField>
              <FormField
                label="Plugin collection"
                hint="Enabled in addition to any plugin_collection_id on the step."
              >
                <SelectField
                  value={
                    effective.preference?.mode === 'inline'
                      ? (effective.preference.plugin_collection_id ?? '')
                      : ''
                  }
                  onChange={(e) =>
                    updateInline({ plugin_collection_id: e.target.value })
                  }
                  options={[
                    { value: '', label: 'None' },
                    ...pluginCollections.map((collection) => ({
                      value: collection.id,
                      label: `${collection.name || collection.id} (${collection.id})`,
                    })),
                  ]}
                  disabled={readonly}
                />
              </FormField>
            </div>
          )}

          {currentMode === 'agent' && (
            <FormField
              label="Agent"
              hint="Uses the agent base model, instructions, and plugins at run time."
            >
              {agents.length === 0 ? (
                <p className="text-xs fg-secondary italic">
                  No local agents available
                </p>
              ) : (
                <SelectField
                  value={
                    effective.preference?.mode === 'agent'
                      ? effective.preference.agent_id
                      : ''
                  }
                  onChange={(e) =>
                    onChange({ mode: 'agent', agent_id: e.target.value })
                  }
                  options={agents.map((agent) => ({
                    value: agent.id,
                    label: `${agent.name} (${agent.id})${
                      availableAgentIds.has(agent.id) ? '' : ' - unavailable'
                    }`,
                  }))}
                  placeholder="Select an agent"
                  disabled={readonly}
                />
              )}
            </FormField>
          )}

          {currentMode === null && (
            <p className="text-xs fg-secondary">
              Choose an inline model or an agent for this alias.
            </p>
          )}

          {validationError && (
            <p
              className="text-xs fg-destructive"
              data-testid={`pipeline-model-alias-${alias.id}-error`}
            >
              {validationError}
            </p>
          )}

          {!readonly && effective.customized && (
            <Button
              size="compact"
              onClick={handleResetOrClear}
              data-testid={`pipeline-model-alias-${alias.id}-reset`}
            >
              {hasDefaults ? 'Reset to defaults' : 'Clear custom value'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
