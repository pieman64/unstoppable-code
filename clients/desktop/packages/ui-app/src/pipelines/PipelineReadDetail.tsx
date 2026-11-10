'use client';

import { Count } from '@canopy/ui-shared/components/Badge';
import { type JSX, useState } from 'react';
import type { PortalPipelineDefinitionViewModel } from '@canopy/protocol/portal';
import { PipelineIcon } from '@canopy/ui-shared';
import { Stack, Button, Heading } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { EmptyStateRow } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';
import { PipelineStepRow } from './PipelineStepRow';

export interface PipelineReadDetailProps {
  definition: PortalPipelineDefinitionViewModel;
  onOpenEditor?: () => void;
  /**
   * Drop the top padding because the host already spaced this panel — the
   * marketplace detail shell's Back row owns that gap. A typed flag rather
   * than a `className` override: both `py-6` and a `pt-0` passed in emit
   * `padding-top`, so which one wins would come down to stylesheet order,
   * not the order they appear in the class attribute.
   */
  flushTop?: boolean;
}

function scopeLabel(
  scope: PortalPipelineDefinitionViewModel['scopes'][number],
): string {
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

export function PipelineReadDetail({
  definition,
  onOpenEditor,
  flushTop = false,
}: PipelineReadDetailProps): JSX.Element {
  const [showYaml, setShowYaml] = useState(false);

  return (
    <article
      className={`mx-auto w-full max-w-4xl flex flex-col gap-6 px-6 ${
        flushTop ? 'pb-6' : 'py-6'
      }`}
      data-testid="pipeline-read-detail"
    >
      <Surface
        as="header"
        variant="card"
        padding="default"
        data-testid="pipeline-read-detail-meta"
      >
        <div className="flex items-start gap-3">
          <Surface variant="group" className="w-10 shrink-0">
            <div className="flex h-10 items-center justify-center fg-secondary">
              {definition.icon ? (
                <span className="text-lg">{definition.icon}</span>
              ) : (
                <PipelineIcon size="xl" />
              )}
            </div>
          </Surface>
          <div className="min-w-0 flex-1 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Heading level={1} variant="page">
                {definition.name}
              </Heading>
              {definition.version && (
                <span className="text-xs fg-tertiary">
                  v{definition.version}
                </span>
              )}
            </div>
            {definition.description && (
              <p className="text-s fg-secondary">{definition.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {/* A run's recorded snapshot keeps no triggers. */}
              {definition.triggerSummary !== '' && (
                <span className="rounded bg-info-subtle px-2 py-1 text-xs fg-info">
                  {definition.triggerSummary}
                </span>
              )}
              {definition.scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded bg-secondary px-2 py-1 text-xs fg-secondary"
                >
                  {scopeLabel(scope)}
                </span>
              ))}
            </div>
          </div>
          {onOpenEditor && (
            <Button
              type="button"
              size="compact"
              onClick={onOpenEditor}
              data-testid="pipeline-read-detail-open-editor"
            >
              Open in editor
            </Button>
          )}
        </div>
      </Surface>

      <Stack
        as="section"
        gap="item"
        aria-labelledby="pipeline-read-detail-jobs-heading"
      >
        <div className="flex items-center justify-between">
          <Heading
            level={2}
            variant="title"
            id="pipeline-read-detail-jobs-heading"
          >
            Jobs ({definition.jobs.length})
          </Heading>
          {definition.canonicalYaml !== undefined && (
            <Button
              type="button"
              size="compact"
              aria-expanded={showYaml}
              onClick={() => setShowYaml((visible) => !visible)}
              data-testid="pipeline-read-detail-yaml-toggle"
            >
              Raw
            </Button>
          )}
        </div>

        {showYaml && definition.canonicalYaml !== undefined ? (
          <Stack gap="inline">
            {definition.canonicalYamlTruncated === true && (
              <p className="text-xs fg-secondary">
                YAML truncated in transfer.
              </p>
            )}
            {/* Raw YAML holds prompts, scripts, and env values. */}
            <Surface variant="group" className="overflow-hidden">
              <pre
                className={`${REPLAY_BLOCK_CLASS} max-h-144 overflow-auto p-4 text-xs fg-primary`}
                data-testid="pipeline-read-detail-yaml"
              >
                <code>{definition.canonicalYaml}</code>
              </pre>
            </Surface>
          </Stack>
        ) : (
          <Stack gap="item">
            {definition.jobs.map((job) => (
              <Surface
                key={job.id}
                as="article"
                variant="outline"
                className="overflow-hidden"
                data-testid="pipeline-read-detail-job"
              >
                <div className="flex items-center gap-2 bg-secondary/50 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
                    {job.name}
                  </span>
                  {job.dependencies.map((dependency) => (
                    <span
                      key={dependency}
                      className="font-mono text-xs fg-secondary"
                    >
                      {dependency}
                    </span>
                  ))}
                  <Count value={job.steps.length} />
                </div>
                {/* 2px inside the job's 12px corners keeps the 10px rows concentric. */}
                <ol className="flex flex-col p-0.5">
                  {job.steps.length === 0 && (
                    <li>
                      <EmptyStateRow title="No steps yet" />
                    </li>
                  )}
                  {job.steps.map((step) => (
                    <li key={step.id}>
                      <PipelineStepRow
                        name={step.name}
                        kind={step.kind}
                        summary={step.usesSummary}
                        data-testid="pipeline-read-detail-step"
                      />
                    </li>
                  ))}
                </ol>
              </Surface>
            ))}
          </Stack>
        )}
      </Stack>
    </article>
  );
}
