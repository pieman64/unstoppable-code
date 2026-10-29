import type {
  ExecutionState,
  ExecutionSummary,
  JobResult,
  MaterializedJob,
  NormalizedStep,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';

export type SelectedStepSource = 'current' | 'retry' | 'iteration';

export type AttemptTimelineSource = JobResult;

export interface SelectedStepRef {
  jobId: string;
  stepId: string;
  attempt: number;
  iteration?: number;
  source: SelectedStepSource;
}

export interface AttemptView {
  attempt: number;
  iteration?: number;
  source: SelectedStepSource;
  label: string;
  status: JobResult['status'];
  steps: Record<string, StepResult>;
  started_at?: string;
  completed_at?: string;
}

export interface ResolvedSelectedStep {
  jobId: string;
  jobDef: MaterializedJob;
  stepDef: NormalizedStep;
  stepResult: StepResult | undefined;
  attemptView: AttemptView | null;
  attempt: number;
  source: SelectedStepSource;
}

function getMinTimestamp(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) {
    return undefined;
  }

  return timestamps.reduce((earliest, current) =>
    Date.parse(current) < Date.parse(earliest) ? current : earliest,
  );
}

function getMaxTimestamp(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) {
    return undefined;
  }

  return timestamps.reduce((latest, current) =>
    Date.parse(current) > Date.parse(latest) ? current : latest,
  );
}

function isRetryContext(
  retryHistoryLength: number,
  currentAttempt: number,
): boolean {
  return retryHistoryLength > 0 || currentAttempt > 0;
}

function formatHistoricalIterationLabel(
  attempt: number,
  iteration: number,
  hasRetryContext: boolean,
): string {
  if (!hasRetryContext) {
    return `Iteration ${String(iteration)}`;
  }

  return `Attempt ${String(attempt + 1)} / Iteration ${String(iteration)}`;
}

function formatCurrentLabel(
  attempt: number,
  iteration: number,
  hasRetryContext: boolean,
  hasIterationContext: boolean,
): string {
  if (!hasIterationContext) {
    return `Attempt ${String(attempt + 1)} (current)`;
  }

  if (!hasRetryContext) {
    return `Iteration ${String(iteration)} (current)`;
  }

  return `Attempt ${String(attempt + 1)} / Iteration ${String(iteration)} (current)`;
}

function deriveCurrentAttemptTiming(
  jobResult: AttemptTimelineSource | undefined,
): Pick<AttemptView, 'started_at' | 'completed_at'> {
  if (!jobResult) {
    return {};
  }

  const steps = Object.values(jobResult.steps);
  const startedAt = getMinTimestamp(
    steps
      .map((step) => step.started_at)
      .filter((value): value is string => value !== undefined),
  );
  const hasRunningStep = steps.some((step) => step.status === 'running');
  const completedAt = hasRunningStep
    ? undefined
    : getMaxTimestamp(
        steps
          .map((step) => step.completed_at)
          .filter((value): value is string => value !== undefined),
      );

  return {
    started_at: startedAt,
    completed_at: completedAt,
  };
}

/**
 * A settled step: it finished and its log will not grow. Pending, running,
 * and paused steps, and steps that have not started, are unsettled.
 */
export function isTerminalStepStatus(
  status: StepResult['status'] | undefined,
): boolean {
  return (
    status === 'success' ||
    status === 'failure' ||
    status === 'cancelled' ||
    status === 'skipped'
  );
}

export function getCurrentAttemptNumber(
  jobResult: AttemptTimelineSource | undefined,
): number {
  return Math.max(
    jobResult?.retry_count ?? 0,
    jobResult?.retry_history?.length ?? 0,
  );
}

/**
 * Stable key for one step instance.
 *
 * Matrix variants already have distinct physical job IDs, so the ordinary
 * job/attempt/step tuple remains unique.
 */
export function buildStepInstanceKey(
  jobId: string,
  source: SelectedStepSource,
  attempt: number,
  stepId: string,
  iteration?: number,
): string {
  return [jobId, source, String(attempt), String(iteration ?? 1), stepId].join(
    ':',
  );
}

export function buildAttemptViews(
  jobResult: AttemptTimelineSource | undefined,
): AttemptView[] {
  const retryHistory = [...(jobResult?.retry_history ?? [])].sort(
    (left, right) => left.attempt - right.attempt,
  );
  const currentAttempt = getCurrentAttemptNumber(jobResult);
  const currentIteration = jobResult?.iteration_count ?? 1;
  const hasRetryContext = isRetryContext(retryHistory.length, currentAttempt);
  const currentIterationHistory = [
    ...(jobResult?.iteration_history ?? []),
  ].sort((left, right) => left.iteration - right.iteration);
  const hasIterationContext =
    currentIterationHistory.length > 0 || currentIteration > 1;
  const views: AttemptView[] = [];

  for (const retry of retryHistory) {
    const iterationHistory = [...(retry.iteration_history ?? [])].sort(
      (left, right) => left.iteration - right.iteration,
    );
    for (const snapshot of iterationHistory) {
      views.push({
        attempt: retry.attempt,
        iteration: snapshot.iteration,
        source: 'iteration',
        label: formatHistoricalIterationLabel(
          retry.attempt,
          snapshot.iteration,
          hasRetryContext,
        ),
        status: snapshot.status,
        steps: snapshot.steps,
        started_at: snapshot.started_at,
        completed_at: snapshot.completed_at,
      });
    }

    views.push({
      attempt: retry.attempt,
      source: 'retry',
      label: `Attempt ${String(retry.attempt + 1)} (${retry.status})`,
      status: retry.status,
      steps: retry.steps,
      started_at: retry.started_at,
      completed_at: retry.completed_at,
    });
  }

  for (const snapshot of currentIterationHistory) {
    views.push({
      attempt: currentAttempt,
      iteration: snapshot.iteration,
      source: 'iteration',
      label: formatHistoricalIterationLabel(
        currentAttempt,
        snapshot.iteration,
        hasRetryContext,
      ),
      status: snapshot.status,
      steps: snapshot.steps,
      started_at: snapshot.started_at,
      completed_at: snapshot.completed_at,
    });
  }

  views.push({
    attempt: currentAttempt,
    iteration: currentIteration,
    source: 'current',
    label: formatCurrentLabel(
      currentAttempt,
      currentIteration,
      hasRetryContext,
      hasIterationContext,
    ),
    status: jobResult?.status ?? 'pending',
    steps: jobResult?.steps ?? {},
    ...deriveCurrentAttemptTiming(jobResult),
  });

  return views;
}

export function resolveSelectedStep(
  state: ExecutionState,
  selectedStep: SelectedStepRef | null,
): ResolvedSelectedStep | null {
  if (!selectedStep) {
    return null;
  }

  const snapshotJob = state.pipeline_snapshot.jobs[selectedStep.jobId];
  const jobDef =
    state.job_definitions?.[selectedStep.jobId] ??
    (snapshotJob
      ? {
          ...snapshotJob,
          physical_job_id: selectedStep.jobId,
          logical_job_id: selectedStep.jobId,
        }
      : undefined);
  if (!jobDef) {
    return null;
  }

  const stepDef = jobDef.steps.find((step) => step.id === selectedStep.stepId);
  if (!stepDef) {
    return null;
  }

  const timelineSource = state.jobs[selectedStep.jobId];

  const resolvedAttempt =
    selectedStep.source === 'current'
      ? getCurrentAttemptNumber(timelineSource)
      : selectedStep.attempt;
  const attemptView =
    buildAttemptViews(timelineSource).find(
      (entry) =>
        entry.source === selectedStep.source &&
        entry.attempt === resolvedAttempt &&
        (selectedStep.source !== 'iteration' ||
          entry.iteration === selectedStep.iteration),
    ) ?? null;

  return {
    jobId: selectedStep.jobId,
    jobDef,
    stepDef,
    stepResult: attemptView?.steps[selectedStep.stepId],
    attemptView,
    attempt: resolvedAttempt,
    source: selectedStep.source,
  };
}

function createSelection(
  jobId: string,
  stepId: string,
  attemptView: AttemptView,
): SelectedStepRef {
  return {
    jobId,
    stepId,
    attempt: attemptView.attempt,
    iteration: attemptView.iteration,
    source: attemptView.source,
  };
}

interface DefaultSelectionCandidates {
  running: SelectedStepRef | null;
  currentTerminal: SelectedStepRef | null;
  historicalTerminal: SelectedStepRef | null;
  fallback: SelectedStepRef | null;
}

/**
 * Collect default-selection candidates from one physical job timeline.
 */
function collectDefaultSelectionCandidates(
  jobId: string,
  jobDef: MaterializedJob,
  source: AttemptTimelineSource | undefined,
  into: DefaultSelectionCandidates,
): void {
  const attemptViews = buildAttemptViews(source);
  const currentView =
    attemptViews.find((attemptView) => attemptView.source === 'current') ??
    null;

  if (currentView) {
    for (const step of jobDef.steps) {
      if (
        into.running === null &&
        currentView.steps[step.id]?.status === 'running'
      ) {
        into.running = createSelection(jobId, step.id, currentView);
      }
      if (isTerminalStepStatus(currentView.steps[step.id]?.status)) {
        into.currentTerminal = createSelection(jobId, step.id, currentView);
      }
    }

    if (into.fallback === null && jobDef.steps.length > 0) {
      into.fallback = createSelection(jobId, jobDef.steps[0].id, currentView);
    }
  }

  for (const attemptView of attemptViews) {
    if (attemptView.source === 'current') {
      continue;
    }
    for (const step of jobDef.steps) {
      if (isTerminalStepStatus(attemptView.steps[step.id]?.status)) {
        into.historicalTerminal = createSelection(jobId, step.id, attemptView);
      }
    }
  }
}

export function findDefaultSelection(
  state: ExecutionState,
): SelectedStepRef | null {
  const candidates: DefaultSelectionCandidates = {
    running: null,
    currentTerminal: null,
    historicalTerminal: null,
    fallback: null,
  };

  const definitions =
    state.job_definitions ??
    Object.fromEntries(
      Object.entries(state.pipeline_snapshot.jobs).map(([jobId, job]) => [
        jobId,
        {
          ...job,
          physical_job_id: jobId,
          logical_job_id: jobId,
        },
      ]),
    );
  for (const [jobId, jobDef] of Object.entries(definitions)) {
    const jobResult = state.jobs[jobId];
    collectDefaultSelectionCandidates(jobId, jobDef, jobResult, candidates);
  }

  return (
    candidates.running ??
    candidates.currentTerminal ??
    candidates.historicalTerminal ??
    candidates.fallback
  );
}

export function findChildExecutionSummary(
  childSummaries: ExecutionSummary[],
  stepId: string,
  attempt: number,
  iteration?: number,
  preferredChildExecutionId?: string,
): ExecutionSummary | undefined {
  if (preferredChildExecutionId) {
    const preferred = childSummaries.find(
      (summary) => summary.id === preferredChildExecutionId,
    );
    if (preferred) return preferred;
  }

  const candidates = childSummaries.filter(
    (summary) =>
      summary.parent_step_id === stepId &&
      (summary.parent_attempt === undefined ||
        summary.parent_attempt === attempt),
  );

  if (candidates.length === 0) {
    return undefined;
  }

  // If an iteration is specified, prefer an exact attempt+iteration match
  if (iteration !== undefined) {
    const exact = candidates.find(
      (summary) =>
        summary.parent_attempt === attempt &&
        summary.parent_iteration === iteration,
    );
    if (exact) {
      return exact;
    }
  }

  // Prefer non-iteration-specific entries (attempt-only or legacy)
  const nonIterationMatch = candidates.find(
    (summary) => summary.parent_iteration === undefined,
  );
  if (nonIterationMatch) {
    return nonIterationMatch;
  }

  // If no iteration was specified, fall back to any remaining candidate
  if (iteration === undefined) {
    return candidates[0];
  }

  return undefined;
}
