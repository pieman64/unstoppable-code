'use client';

import { type JSX, useState } from 'react';
import type { PortalPipelineDefinitionViewModel } from '@canopy/protocol/portal';
import { PipelineIcon } from '@canopy/ui-shared';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

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
      className={`mx-auto w-full max-w-4xl space-y-6 px-6 ${
        flushTop ? 'pb-6' : 'py-6'
      }`}
      data-testid="pipeline-read-detail"
    >
      <header
        className="card-surface p-5"
        data-testid="pipeline-read-detail-meta"
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary fg-secondary">
            {definition.icon ? (
              <span className="text-lg">{definition.icon}</span>
            ) : (
              <PipelineIcon className="h-5 w-5" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold fg-primary">
                {definition.name}
              </h1>
              {definition.version && (
                <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary">
                  v{definition.version}
                </span>
              )}
            </div>
            {definition.description && (
              <p className="mt-1 text-s fg-secondary">
                {definition.description}
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
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
            <button
              type="button"
              onClick={onOpenEditor}
              data-testid="pipeline-read-detail-open-editor"
              className="rounded-md border px-3 py-1.5 text-xs font-medium fg-secondary hover:bg-secondary hover:fg-primary"
            >
              Open in editor
            </button>
          )}
        </div>
      </header>

      <section aria-labelledby="pipeline-read-detail-jobs-heading">
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="pipeline-read-detail-jobs-heading"
            className="text-s font-semibold fg-primary"
          >
            Jobs ({definition.jobs.length})
          </h2>
          {definition.canonicalYaml !== undefined && (
            <button
              type="button"
              aria-expanded={showYaml}
              onClick={() => setShowYaml((visible) => !visible)}
              data-testid="pipeline-read-detail-yaml-toggle"
              className="rounded-md border px-3 py-1.5 text-xs font-medium fg-secondary hover:bg-secondary hover:fg-primary"
            >
              Raw
            </button>
          )}
        </div>

        {showYaml && definition.canonicalYaml !== undefined ? (
          <div className="space-y-2">
            {definition.canonicalYamlTruncated === true && (
              <p className="text-xs fg-secondary">
                YAML truncated in transfer.
              </p>
            )}
            {/* Raw YAML holds prompts, scripts, and env values. */}
            <pre
              className={`${REPLAY_BLOCK_CLASS} max-h-144 overflow-auto rounded-lg border bg-secondary/40 p-4 text-xs fg-primary`}
              data-testid="pipeline-read-detail-yaml"
            >
              <code>{definition.canonicalYaml}</code>
            </pre>
          </div>
        ) : (
          <div className="space-y-3">
            {definition.jobs.map((job) => (
              <article
                key={job.id}
                className="overflow-hidden rounded-lg border"
                data-testid="pipeline-read-detail-job"
              >
                <div className="flex items-center gap-2 bg-secondary/50 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
                    {job.name}
                  </span>
                  {job.dependencies.map((dependency) => (
                    <span
                      key={dependency}
                      className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary"
                    >
                      {dependency}
                    </span>
                  ))}
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-3xs font-medium fg-secondary">
                    {job.steps.length}
                  </span>
                </div>
                <ol className="space-y-1.5 p-2">
                  {job.steps.length === 0 && (
                    <li className="py-4 text-center text-xs fg-secondary">
                      No steps yet
                    </li>
                  )}
                  {job.steps.map((step) => (
                    <li
                      key={step.id}
                      className="card-surface flex items-center gap-3 px-3 py-2.5"
                      data-testid="pipeline-read-detail-step"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-s font-medium fg-primary">
                            {step.name}
                          </span>
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium ${step.kind === 'action' ? 'bg-info-subtle fg-info' : step.kind === 'script' ? 'bg-warning-subtle fg-warning' : 'bg-secondary fg-secondary'}`}
                          >
                            {step.kind === 'action'
                              ? 'Action'
                              : step.kind === 'script'
                                ? 'Script'
                                : 'Incomplete'}
                          </span>
                        </div>
                        {/* Action refs are recorded; a script's first line is blocked. */}
                        <p
                          className={`${step.kind === 'action' ? '' : REPLAY_BLOCK_CLASS} mt-0.5 truncate text-xs fg-secondary`}
                        >
                          {step.usesSummary}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
