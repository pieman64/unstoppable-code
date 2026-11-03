import { type JSX, useEffect, useState } from 'react';
import { Button } from '@canopy/ui-shared/components';
import type { AutomationPipelineDependency } from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { SettingsSelect } from '@canopy/ui-shared/components';

const HELPER =
  'Sharing includes these pipelines so recipients get a copy that runs. A pipeline whose ID is in the prompt is included automatically.';
const ADD_PLACEHOLDER = 'Add a pipeline…';
const MISSING_LABEL = 'Pipeline not found';

interface AutomationPipelineDependenciesFieldProps {
  value: readonly AutomationPipelineDependency[];
  disabled: boolean;
  onChange: (next: AutomationPipelineDependency[]) => void;
}

/**
 * The local pipelines a prompt automation runs. The prompt names them for
 * the agent; this list makes sure a share packages them even when the
 * prompt only mentions them by name. Lists the user's own pipelines.
 */
export function AutomationPipelineDependenciesField({
  value,
  disabled,
  onChange,
}: AutomationPipelineDependenciesFieldProps): JSX.Element {
  const [pipelines, setPipelines] = useState<PipelineInfo[] | null>(null);
  useEffect(() => {
    const listPipelines = window.pipelines?.list?.bind(window.pipelines);
    if (!listPipelines) {
      setPipelines([]);
      return undefined;
    }
    let cancelled = false;
    void listPipelines()
      .then((result) => {
        if (cancelled) return;
        setPipelines(
          (result.data ?? []).filter((pipeline) => pipeline.source === 'user'),
        );
      })
      .catch(() => {
        if (!cancelled) setPipelines([]);
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const selectedIds = new Set(value.map((entry) => entry.pipelineId));
  const available = (pipelines ?? []).filter(
    (pipeline) => !selectedIds.has(pipeline.id),
  );
  const nameFor = (entry: AutomationPipelineDependency): string =>
    pipelines?.find((pipeline) => pipeline.id === entry.pipelineId)?.name ??
    (pipelines === null ? entry.pipelineId : MISSING_LABEL);

  return (
    <div className="space-y-2" data-testid="automations-form-pipelines">
      <p className="text-2xs fg-secondary">{HELPER}</p>
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((entry) => (
            <li
              key={`${entry.source}:${entry.pipelineId}`}
              className="flex items-center justify-between gap-2 rounded-md border bg-base px-2 py-1.5 text-xs"
              data-testid={`automations-form-pipeline-dependency-${entry.pipelineId}`}
            >
              <span className="min-w-0 truncate fg-primary">
                {nameFor(entry)}
              </span>
              <Button
                variant="ghost-quiet"
                size="compact"
                disabled={disabled}
                onClick={(): void =>
                  onChange(
                    value.filter(
                      (candidate) =>
                        candidate.pipelineId !== entry.pipelineId ||
                        candidate.source !== entry.source,
                    ),
                  )
                }
                aria-label={`Remove ${nameFor(entry)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <SettingsSelect
        width="fill"
        value={null}
        placeholder={ADD_PLACEHOLDER}
        disabled={disabled || available.length === 0}
        onValueChange={(pipelineId): void => {
          onChange([...value, { pipelineId, source: 'user' }]);
        }}
        aria-label="Add a pipeline"
        data-testid="automations-form-pipeline-dependency-add"
        options={available.map((pipeline) => ({
          value: pipeline.id,
          label: pipeline.name,
        }))}
      />
    </div>
  );
}
