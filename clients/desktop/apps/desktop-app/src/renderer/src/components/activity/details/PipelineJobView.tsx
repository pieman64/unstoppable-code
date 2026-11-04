import { memo, useState, type JSX } from 'react';
import { EmptyState, ErrorBanner, Heading } from '@canopy/ui-shared/components';
import type {
  ExecutionState,
  ExecutionSummary,
} from '@canopy/desktop-shared/types/pipeline';
import type { PipelineRunStepCost } from '@canopy/protocol/cost-view';
import { formatCostTotal } from '@canopy/ui-shared/components/cost';
import {
  buildAttemptViews,
  buildStepInstanceKey,
  findChildExecutionSummary,
} from '@/lib/pipelineAttemptTimeline';
import { Badge, StatusGlyph } from '@canopy/ui-shared/components';
import { pipelineStatusBadge, pipelineStatusGlyphState } from '../utils';
import { PipelineChildExecution } from './PipelineChildExecution';
import { TimingSummaryGrid } from './PipelineStepDetailParts';
import { PipelineStepRow } from './PipelineStepRow';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import type { ArchivedPipelineSource } from './pipelineDetailTypes';
import {
  canRetryAllMatrixVariants,
  canRetryFailedMatrixVariants,
  canRetryMatrixExpansion,
  canRetryMatrixJob,
  canRetryMatrixVariant,
} from '@/lib/execution-actions';
import { Button } from '@canopy/ui-shared/components';

function isSettledJobStatus(status: string): boolean {
  return ['success', 'failure', 'cancelled', 'skipped'].includes(status);
}

interface PipelineJobViewProps {
  state: ExecutionState;
  jobId: string;
  executionId: string;
  childSummaries: ExecutionSummary[];
  expandedChildSteps: Set<string>;
  onToggleChildStep: (stepInstanceKey: string) => void;
  renderChildExecution: (executionId: string) => JSX.Element;
  /** Open the worker for a terminal-mode step. */
  onViewWorker?: (workerId: string) => void;
  /** Drill into a child pipeline as a new breadcrumb level of the detail. */
  onDrillIntoChild?: (childExecutionId: string, label: string) => void;
  /** Selected physical matrix variant, or undefined for the logical group. */
  selectedMatrixVariantId?: string;
  onSelectMatrixVariant?: (variantJobId: string | undefined) => void;
  /**
   * Read-only archived source. Step logs use the archive transport and the
   * live-only matrix retry and cancel controls are hidden.
   */
  archivedSource?: ArchivedPipelineSource;
  /** The detail's visibility gate for live step log interests. */
  logsEnabled?: boolean;
  /** Step costs for the run shown in this job view. */
  stepCosts?: readonly PipelineRunStepCost[];
}

/**
 * GitHub-Actions-style job view: a job header followed by a step accordion. Each
 * step is collapsed by default except running steps (auto-expanded), and
 * expanding a step reveals its full detail (timing/config/inputs/outputs) plus
 * the live or persisted log output.
 *
 * Memoized so streaming output ticks do not re-render the whole job view or its
 * collapsed step rows. Only expanded `PipelineStepDetail`s, which each hold and
 * subscribe to their own step log interest, re-render on a pure output tick.
 */
function PipelineJobViewComponent({
  state,
  jobId,
  executionId,
  childSummaries,
  expandedChildSteps,
  onToggleChildStep,
  renderChildExecution,
  onViewWorker,
  onDrillIntoChild,
  selectedMatrixVariantId,
  onSelectMatrixVariant,
  archivedSource,
  logsEnabled,
  stepCosts,
}: PipelineJobViewProps): JSX.Element {
  const archived = archivedSource !== undefined;
  const retryMatrixJob = usePipelineRunsStore((store) => store.retryMatrixJob);
  const cancelMatrixVariant = usePipelineRunsStore(
    (store) => store.cancelMatrixVariant,
  );
  const [matrixBusy, setMatrixBusy] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const runMatrixAction = async (
    action: () => Promise<{ success: boolean; error?: string }>,
    fallbackError: string,
  ): Promise<void> => {
    setMatrixBusy(true);
    setMatrixError(null);
    try {
      const result = await action();
      setMatrixError(result.success ? null : (result.error ?? fallbackError));
    } catch (error) {
      setMatrixError(error instanceof Error ? error.message : fallbackError);
    } finally {
      setMatrixBusy(false);
    }
  };
  const group = state.job_groups[jobId];
  if (group?.kind === 'matrix' && !selectedMatrixVariantId) {
    const logicalJob = state.pipeline_snapshot.jobs[jobId];
    // Matrix retry and cancel mutate a live run; an archived run has none.
    const canRetryExpansion =
      !archived &&
      canRetryMatrixExpansion(
        state.status,
        group,
        logicalJob.strategy?.dynamic === true,
      );
    const canRetryAll =
      !archived && canRetryAllMatrixVariants(state.status, group);
    const canRetryFailed =
      !archived &&
      canRetryFailedMatrixVariants(state.status, group, state.jobs);
    return (
      <div className="space-y-4" data-testid={`pipeline-matrix-view-${jobId}`}>
        <div className="rounded-xl border bg-base p-4">
          <div className="flex items-center gap-2">
            <Heading level={2} variant="section">
              {logicalJob.name}
            </Heading>
            <Badge>matrix</Badge>
          </div>
          <div className="mt-2 text-s fg-secondary">
            {group.variant_job_ids.length} variants
          </div>
          <div className="mt-1 text-xs fg-secondary">
            Max parallel: {group.resolved_max_parallel ?? '—'} · Fail fast:{' '}
            {group.fail_fast ? 'On' : 'Off'}
          </div>
          {group.outcome === 'failure' && group.conclusion === 'success' ? (
            <p className="mt-1 text-xs fg-warning">Continued after failures</p>
          ) : null}
          {group.expansion === 'pending' ? (
            <p className="mt-3 text-s fg-secondary">Preparing variants…</p>
          ) : group.expansion === 'failure' ? (
            <div className="mt-3">
              <h3 className="text-s font-medium fg-destructive">
                Expansion failed
              </h3>
              <p className="text-xs fg-secondary">{group.error}</p>
            </div>
          ) : group.variant_job_ids.length === 0 ? (
            <p className="mt-3 text-s fg-secondary">
              No variants were generated for this job.
            </p>
          ) : null}
          {canRetryExpansion || canRetryAll || canRetryFailed ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {canRetryExpansion || canRetryAll ? (
                <Button
                  size="compact"
                  disabled={matrixBusy}
                  onClick={() => {
                    setMatrixBusy(true);
                    void retryMatrixJob({
                      executionId,
                      jobId,
                      mode: canRetryExpansion ? 'expansion' : 'all',
                    }).then((result) => {
                      setMatrixBusy(false);
                      setMatrixError(result.error ?? null);
                    });
                  }}
                >
                  {matrixBusy
                    ? 'Trying again…'
                    : canRetryExpansion
                      ? 'Try expansion again'
                      : 'Try all variants again'}
                </Button>
              ) : null}
              {canRetryFailed ? (
                <Button
                  size="compact"
                  disabled={matrixBusy}
                  onClick={() => {
                    setMatrixBusy(true);
                    void retryMatrixJob({
                      executionId,
                      jobId,
                      mode: 'failed',
                    }).then((result) => {
                      setMatrixBusy(false);
                      setMatrixError(result.error ?? null);
                    });
                  }}
                >
                  Try failed variants again
                </Button>
              ) : null}
            </div>
          ) : null}
          <ErrorBanner error={matrixError} className="mt-2" />
        </div>
        <div className="max-h-96 space-y-1 overflow-y-auto rounded-xl border bg-base p-2">
          {group.variant_job_ids.map((variantJobId) => {
            const definition = state.job_definitions[variantJobId];
            const result = state.jobs[variantJobId];
            return (
              <div
                key={variantJobId}
                className="flex items-center rounded-md hover:bg-fg-primary/[0.04]"
              >
                <button
                  type="button"
                  onClick={() => onSelectMatrixVariant?.(variantJobId)}
                  className="flex min-w-0 flex-1 items-center justify-between px-3 py-2 text-left"
                >
                  <span className="min-w-0 truncate text-s fg-primary">
                    {definition.name}
                  </span>
                  <span className="ml-3 text-xs fg-secondary">
                    {JSON.stringify(definition.matrix?.values ?? {})} ·{' '}
                    {result.status}
                  </span>
                </button>
                {archived ? null : !isSettledJobStatus(result.status) ? (
                  <Button
                    variant="ghost-destructive"
                    size="compact"
                    className="ml-2"
                    disabled={matrixBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runMatrixAction(
                        () =>
                          cancelMatrixVariant({
                            executionId,
                            jobId,
                            variantJobId,
                          }),
                        'Failed to cancel matrix variant',
                      );
                    }}
                  >
                    Cancel variant
                  </Button>
                ) : canRetryMatrixJob(state.status, group) &&
                  canRetryMatrixVariant({
                    job_id: variantJobId,
                    status: result.status,
                  }) ? (
                  <Button
                    variant="ghost"
                    size="compact"
                    className="ml-2"
                    disabled={matrixBusy}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runMatrixAction(
                        () =>
                          retryMatrixJob({
                            executionId,
                            jobId,
                            mode: 'variants',
                            variantJobIds: [variantJobId],
                          }),
                        'Failed to retry matrix variant',
                      );
                    }}
                  >
                    Try variant again
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const displayJobId = selectedMatrixVariantId ?? jobId;
  const jobDef =
    state.job_definitions[displayJobId] ?? state.pipeline_snapshot.jobs[jobId];
  const jobResult = state.jobs[displayJobId];

  const jobName = jobDef?.name ?? displayJobId;
  const jobStatus = jobResult?.status ?? 'pending';
  const attemptViews = buildAttemptViews(jobResult);
  const steps = jobDef?.steps ?? [];
  const hasStartedSteps = attemptViews.some(
    (attemptView) => Object.keys(attemptView.steps).length > 0,
  );
  const showAttemptGroups =
    attemptViews.length > 1 ||
    (jobDef?.max_retries ?? 0) > 0 ||
    (jobDef?.max_iterations ?? 0) > 0;

  return (
    <div
      className="space-y-4"
      data-testid={`pipeline-job-view-${displayJobId}`}
    >
      <div className="rounded-xl border bg-base p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusGlyph
                state={pipelineStatusGlyphState(jobStatus)}
                size={20}
              />
              <Heading level={2} variant="section" truncate>
                {jobName}
              </Heading>
            </div>
            <div className="mt-1 font-mono text-2xs fg-secondary">
              {displayJobId}
            </div>
          </div>
          <Badge {...pipelineStatusBadge(jobStatus)}>{jobStatus}</Badge>
        </div>

        {(jobDef?.max_retries ?? 0) > 0 || (jobDef?.max_iterations ?? 0) > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2 text-2xs fg-secondary">
            {(jobDef?.max_retries ?? 0) > 0 && (
              <span>
                Retries {jobResult?.retry_count ?? 0}/{jobDef?.max_retries}
              </span>
            )}
            {(jobDef?.max_iterations ?? 0) > 0 && (
              <span>
                Iteration {jobResult?.iteration_count ?? 1}/
                {jobDef?.max_iterations}
              </span>
            )}
          </div>
        ) : null}

        <div className="mt-3 rounded-md border bg-fg-primary/[0.03] p-2.5">
          <TimingSummaryGrid
            identity={`job:${executionId}:${displayJobId}:current`}
            kind="job"
            status={jobStatus}
            startedAt={jobResult?.started_at}
            completedAt={jobResult?.completed_at}
            compact
          />
        </div>
      </div>

      {!hasStartedSteps ? (
        <EmptyState title="No steps have started for this job yet." />
      ) : (
        <div className="space-y-4">
          {attemptViews.map((attemptView, attemptViewIndex) => (
            <div
              key={`${displayJobId}-${attemptView.source}-${attemptView.attempt}-${attemptView.iteration ?? 1}`}
              className="space-y-2"
            >
              {showAttemptGroups && (
                <div className="flex items-center justify-between gap-3 text-2xs fg-secondary">
                  <div className="font-medium ">{attemptView.label}</div>
                  {(attemptView.source === 'retry' ||
                    attemptView.source === 'iteration') &&
                    (attemptView.started_at !== undefined ||
                      attemptView.completed_at !== undefined) && (
                      <TimingSummaryGrid
                        identity={`attempt:${executionId}:${displayJobId}:${attemptView.source}:${attemptView.attempt}:${attemptView.iteration ?? 1}`}
                        kind="job"
                        status={attemptView.status}
                        startedAt={attemptView.started_at}
                        completedAt={attemptView.completed_at}
                        source={attemptView.source}
                        compact
                      />
                    )}
                </div>
              )}
              {steps.map((stepDef) => {
                const stepResult = attemptView.steps[stepDef.id];
                const stepCost = stepCosts?.find(
                  (candidate) =>
                    candidate.executionId === executionId &&
                    candidate.jobId === displayJobId &&
                    candidate.stepId === stepDef.id,
                );
                // A retried step's combined cost sits on its latest attempt.
                const stepIsRenderedInALaterAttempt = attemptViews
                  .slice(attemptViewIndex + 1)
                  .some(
                    (laterAttempt) =>
                      laterAttempt.steps[stepDef.id] !== undefined,
                  );
                const iteration = attemptView.iteration ?? 1;
                const stepInstanceKey = buildStepInstanceKey(
                  displayJobId,
                  attemptView.source,
                  attemptView.attempt,
                  stepDef.id,
                  attemptView.iteration,
                );
                const child =
                  stepDef.uses === 'builtin/run-pipeline'
                    ? findChildExecutionSummary(
                        childSummaries,
                        stepDef.id,
                        attemptView.attempt,
                        attemptView.iteration,
                        stepResult?.child_execution_id,
                      )
                    : undefined;
                return (
                  <div key={stepInstanceKey}>
                    <PipelineStepRow
                      stepDef={stepDef}
                      stepResult={stepResult}
                      executionId={executionId}
                      jobId={displayJobId}
                      attempt={attemptView.attempt}
                      iteration={iteration}
                      source={attemptView.source}
                      onViewWorker={onViewWorker}
                      archivedSource={archivedSource}
                      logsEnabled={logsEnabled}
                      costAmount={
                        stepCost !== undefined && !stepIsRenderedInALaterAttempt
                          ? formatCostTotal(stepCost.totals)
                          : undefined
                      }
                    />
                    {child !== undefined && (
                      <PipelineChildExecution
                        child={child}
                        stepId={stepDef.id}
                        expanded={expandedChildSteps.has(stepInstanceKey)}
                        onToggle={(): void =>
                          onToggleChildStep(stepInstanceKey)
                        }
                        renderChildExecution={renderChildExecution}
                        onDrillIntoChild={onDrillIntoChild}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export const PipelineJobView = memo(PipelineJobViewComponent);
