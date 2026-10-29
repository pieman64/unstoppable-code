import type {
  ExecutionState,
  JobResult,
  StepLogLocator,
  StepResult,
} from '../types/pipeline';
import { BRAND } from '@canopy/brand/current';

export interface PipelineFailureDebugContextOptions {
  readStepLog: (locator: StepLogLocator) => Promise<{
    success: boolean;
    data?: { lines: string[] };
    error?: string;
  }>;
  readReportFile: (
    executionId: string,
    kind: 'text' | 'json',
  ) => Promise<{
    success: boolean;
    data?: { content: string; filePath?: string };
    error?: string;
  }>;
}

export interface PipelineFailureDebugContextResult {
  prompt: string;
  failedStepCount: number;
  includedReportKinds: Array<'text' | 'json'>;
}

export type SelectedStepSource = 'current' | 'retry' | 'iteration';

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

interface FailedStepInstance {
  jobId: string;
  jobName: string;
  jobStatus: JobResult['status'];
  attemptView: AttemptView;
  stepId: string;
  stepName: string;
  uses?: string;
  run?: string;
  stepResult: StepResult;
  stepInputs?: Record<string, unknown>;
}

const INTRO_COPY = `Please debug this failed ${BRAND.displayName} pipeline run.

Start by explaining the likely failure cause, then inspect the referenced files/logs if needed, and propose the smallest safe fix or next diagnostic step. Do not assume the pipeline definition is correct just because it normalized successfully.

Environment values are omitted from this prompt; only environment key names are included.`;

const SNAPSHOT_CHAR_LIMIT = 20_000;
const REPORT_CHAR_LIMIT = 12_000;
const LOG_CHAR_LIMIT = 12_000;
const SCALAR_STRING_LIMIT = 1_000;
const LOG_TAIL_LINE_LIMIT = 200;

function getMinTimestamp(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) return undefined;
  return timestamps.reduce((earliest, current) =>
    Date.parse(current) < Date.parse(earliest) ? current : earliest,
  );
}

function getMaxTimestamp(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) return undefined;
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
  if (!hasRetryContext) return `Iteration ${String(iteration)}`;
  return `Attempt ${String(attempt + 1)} / Iteration ${String(iteration)}`;
}

function formatCurrentLabel(
  attempt: number,
  iteration: number,
  hasRetryContext: boolean,
  hasIterationContext: boolean,
): string {
  if (!hasIterationContext) return `Attempt ${String(attempt + 1)} (current)`;
  if (!hasRetryContext) return `Iteration ${String(iteration)} (current)`;
  return `Attempt ${String(attempt + 1)} / Iteration ${String(iteration)} (current)`;
}

function deriveCurrentAttemptTiming(
  jobResult: JobResult | undefined,
): Pick<AttemptView, 'started_at' | 'completed_at'> {
  if (!jobResult) return {};
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
  return { started_at: startedAt, completed_at: completedAt };
}

function isTerminalStepStatus(
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
  jobResult: JobResult | undefined,
): number {
  return Math.max(
    jobResult?.retry_count ?? 0,
    jobResult?.retry_history?.length ?? 0,
  );
}

export function buildAttemptViews(
  jobResult: JobResult | undefined,
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

export function findDefaultSelection(
  state: ExecutionState,
): SelectedStepRef | null {
  let currentTerminal: SelectedStepRef | null = null;
  let historicalTerminal: SelectedStepRef | null = null;
  let fallback: SelectedStepRef | null = null;

  for (const [jobId, jobDef] of Object.entries(state.pipeline_snapshot.jobs)) {
    const attemptViews = buildAttemptViews(state.jobs[jobId]);
    const currentView =
      attemptViews.find((attemptView) => attemptView.source === 'current') ??
      null;

    if (currentView) {
      for (const step of jobDef.steps) {
        const currentStep = currentView.steps[step.id];
        if (currentStep?.status === 'running') {
          return createSelection(jobId, step.id, currentView);
        }
      }

      if (!fallback && jobDef.steps.length > 0) {
        fallback = createSelection(jobId, jobDef.steps[0].id, currentView);
      }

      for (const step of jobDef.steps) {
        if (isTerminalStepStatus(currentView.steps[step.id]?.status)) {
          currentTerminal = createSelection(jobId, step.id, currentView);
        }
      }
    }

    for (const attemptView of attemptViews) {
      if (attemptView.source === 'current') continue;
      for (const step of jobDef.steps) {
        if (isTerminalStepStatus(attemptView.steps[step.id]?.status)) {
          historicalTerminal = createSelection(jobId, step.id, attemptView);
        }
      }
    }
  }

  return currentTerminal ?? historicalTerminal ?? fallback;
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|passwd|credential|api_key|apikey|auth|bearer|private_key|cookie|session|jwt/i.test(
    key,
  );
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function truncateScalarString(value: string): string {
  if (value.length <= SCALAR_STRING_LIMIT) return value;
  return `${value.slice(0, SCALAR_STRING_LIMIT)}\n[truncated ${String(value.length - SCALAR_STRING_LIMIT)} characters]`;
}

function redactValue(value: unknown, visited: WeakSet<object>): unknown {
  if (typeof value === 'string') return truncateScalarString(value);
  if (!isNonNullObject(value)) return value;
  if (visited.has(value)) return '[cycle]';

  visited.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, visited));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key)
      ? '[redacted]'
      : redactValue(childValue, visited);
  }
  return redacted;
}

function redactForPrompt(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function stringifyRedacted(value: unknown, limit: number): string {
  const formatted = JSON.stringify(redactForPrompt(value), null, 2) ?? 'null';
  return truncateEnd(formatted, limit);
}

function truncateEnd(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${String(value.length - limit)} characters]`;
}

function truncateStart(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `[truncated ${String(value.length - limit)} characters from the front]\n${value.slice(value.length - limit)}`;
}

function formatValueLine(label: string, value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return `- ${label}: not set`;
  }

  if (typeof value === 'object') {
    return `- ${label}: ${JSON.stringify(redactForPrompt(value)) ?? 'object'}`;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return `- ${label}: ${String(value)}`;
  }

  if (typeof value === 'symbol') {
    return `- ${label}: ${value.description ?? 'symbol'}`;
  }

  return `- ${label}: function`;
}

function formatJsonBlock(value: unknown, limit: number): string {
  return `\`\`\`json\n${stringifyRedacted(value, limit)}\n\`\`\``;
}

function formatTextBlock(value: string, limit: number): string {
  return `\`\`\`text\n${truncateEnd(value, limit)}\n\`\`\``;
}

function formatPreformattedTextBlock(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}

function formatReportBlock(kind: 'text' | 'json', value: string): string {
  if (kind === 'text') return formatTextBlock(value, REPORT_CHAR_LIMIT);
  try {
    return formatJsonBlock(JSON.parse(value), REPORT_CHAR_LIMIT);
  } catch {
    return formatTextBlock(value, REPORT_CHAR_LIMIT);
  }
}

function getStepReportPaths(stepResult: StepResult): string[] {
  return [
    stepResult.report_outputs?.report_file,
    stepResult.report_outputs?.report_json_file,
  ].filter((value): value is string => value !== undefined && value !== '');
}

function isFailedStepResult(stepResult: StepResult | undefined): boolean {
  return Boolean(
    stepResult &&
    (stepResult.status === 'failure' ||
      (stepResult.exit_code !== undefined && stepResult.exit_code !== 0) ||
      stepResult.error),
  );
}

function collectFailedStepInstances(
  state: ExecutionState,
): FailedStepInstance[] {
  const instances: FailedStepInstance[] = [];

  for (const [jobId, jobDef] of Object.entries(state.job_definitions)) {
    const jobResult = state.jobs[jobId];
    const results: Array<{ result: JobResult; name?: string }> = jobResult
      ? [{ result: jobResult, name: jobDef.name }]
      : [];

    for (const entry of results) {
      const { result } = entry;
      const attemptViews = buildAttemptViews(result);
      for (const attemptView of attemptViews) {
        for (const stepDef of jobDef.steps) {
          const stepResult = attemptView.steps[stepDef.id];
          if (!isFailedStepResult(stepResult)) continue;

          instances.push({
            jobId,
            jobName: entry.name ?? jobDef.name,
            jobStatus: attemptView.status,
            attemptView,
            stepId: stepDef.id,
            stepName: stepDef.name ?? stepDef.id,
            uses: stepDef.uses,
            run: stepDef.run,
            stepResult,
            stepInputs: stepDef.with,
          });
        }
      }
    }
  }

  return instances;
}

function formatSelection(selection: SelectedStepRef | null): string {
  if (!selection) return 'No default step selection was available.';
  return [
    formatValueLine('job id', selection.jobId),
    formatValueLine('step id', selection.stepId),
    formatValueLine('attempt', selection.attempt),
    formatValueLine('iteration', selection.iteration ?? 1),
    formatValueLine('source', selection.source),
  ].join('\n');
}

function appendExecutionSection(lines: string[], state: ExecutionState): void {
  lines.push(
    '## Execution',
    formatValueLine('execution id', state.id),
    formatValueLine('pipeline id', state.pipeline_id),
    formatValueLine('pipeline name', state.pipeline_snapshot.name),
    formatValueLine('status', state.status),
    formatValueLine('cwd', state.cwd),
    formatValueLine('repo path', state.repo_path),
    formatValueLine('project id', state.project_id),
    formatValueLine('worktree id', state.worktree_id),
    formatValueLine('parent execution id', state.parent_execution_id),
    formatValueLine('parent step id', state.parent_step_id),
    formatValueLine('parent attempt', state.parent_attempt),
    formatValueLine('parent iteration', state.parent_iteration),
    formatValueLine('started at', state.started_at),
    formatValueLine('completed at', state.completed_at),
    formatValueLine('rerun source id', state.rerun_source_id),
    formatValueLine('error', state.error),
    '',
  );
}

function appendTriggerSection(lines: string[], state: ExecutionState): void {
  lines.push(
    '## Trigger and Inputs',
    formatValueLine('event_name', state.event_name),
    formatValueLine('inputs_persisted', state.inputs_persisted),
    `- env key names: ${Object.keys(state.env).join(', ') || 'none'}`,
    '',
    '### event_data',
    formatJsonBlock(state.event_data ?? {}, REPORT_CHAR_LIMIT),
    '',
    '### inputs',
    formatJsonBlock(state.inputs, REPORT_CHAR_LIMIT),
    '',
  );
}

function appendPipelineSnapshotSection(
  lines: string[],
  state: ExecutionState,
): void {
  lines.push(
    '## Pipeline Snapshot',
    formatJsonBlock(state.pipeline_snapshot, SNAPSHOT_CHAR_LIMIT),
    '',
  );
}

function appendFailedStepsSection(
  lines: string[],
  state: ExecutionState,
  failedSteps: FailedStepInstance[],
): void {
  lines.push('## Failed Jobs and Steps');

  if (failedSteps.length === 0) {
    lines.push(
      'No failed step instance was recorded.',
      '',
      'Default selection:',
      formatSelection(findDefaultSelection(state)),
    );
    if (state.error) lines.push('', `Top-level error: ${state.error}`);
    lines.push('');
    return;
  }

  for (const failed of failedSteps) {
    lines.push(
      `### ${failed.jobId} / ${failed.stepId} (${failed.attemptView.label})`,
      formatValueLine('job name', failed.jobName),
      formatValueLine('job status', failed.jobStatus),
      formatValueLine('attempt', failed.attemptView.attempt),
      formatValueLine('iteration', failed.attemptView.iteration ?? 1),
      formatValueLine('attempt source', failed.attemptView.source),
      formatValueLine('step name', failed.stepName),
      formatValueLine('uses', failed.uses),
      formatValueLine('run', failed.run),
      formatValueLine('status', failed.stepResult.status),
      formatValueLine('exit code', failed.stepResult.exit_code),
      formatValueLine('error', failed.stepResult.error),
      formatValueLine('log file', failed.stepResult.log_file),
      formatValueLine(
        'transcript path',
        failed.stepResult.outputs.transcript_file,
      ),
      `- report output paths: ${getStepReportPaths(failed.stepResult).join(', ') || 'none'}`,
      '',
      'Step inputs:',
      formatJsonBlock(failed.stepInputs ?? {}, REPORT_CHAR_LIMIT),
      '',
      'Step outputs:',
      formatJsonBlock(failed.stepResult.outputs, REPORT_CHAR_LIMIT),
      '',
    );
  }
}

async function readReportKind(
  state: ExecutionState,
  options: PipelineFailureDebugContextOptions,
  kind: 'text' | 'json',
): Promise<{ content?: string; note?: string }> {
  try {
    const result = await options.readReportFile(state.id, kind);
    if (result.success && result.data) return { content: result.data.content };
    return { note: result.error ?? `${kind} report was not available` };
  } catch (error: unknown) {
    return {
      note:
        error instanceof Error
          ? error.message
          : `${kind} report could not be read`,
    };
  }
}

async function appendReportsSection(
  lines: string[],
  state: ExecutionState,
  options: PipelineFailureDebugContextOptions,
): Promise<Array<'text' | 'json'>> {
  const includedReportKinds: Array<'text' | 'json'> = [];
  lines.push('## Reports');

  for (const kind of ['text', 'json'] as const) {
    const report = await readReportKind(state, options, kind);
    if (report.content !== undefined) {
      includedReportKinds.push(kind);
      lines.push(`### ${kind}`, formatReportBlock(kind, report.content));
    } else {
      lines.push(
        `### ${kind}`,
        `Report read note: ${report.note ?? 'missing'}`,
      );
    }
    lines.push('');
  }

  return includedReportKinds;
}

function formatLogTail(lines: string[]): string {
  const totalLines = lines.length;
  const tailLines = lines.slice(-LOG_TAIL_LINE_LIMIT);
  const omittedLines = Math.max(0, totalLines - tailLines.length);
  const lineMarker =
    omittedLines > 0
      ? `[showing last ${String(tailLines.length)} of ${String(totalLines)} lines]\n`
      : '';
  const bodyLimit = Math.max(0, LOG_CHAR_LIMIT - lineMarker.length);
  const capped = truncateStart(tailLines.join('\n'), bodyLimit);
  return `${lineMarker}${capped}`;
}

async function appendLogTailForStep(
  lines: string[],
  state: ExecutionState,
  options: PipelineFailureDebugContextOptions,
  failed: FailedStepInstance,
): Promise<void> {
  lines.push(
    `### ${failed.jobId} / ${failed.stepId} (${failed.attemptView.label})`,
  );

  const locator: StepLogLocator = {
    executionId: state.id,
    jobId: failed.jobId,
    stepId: failed.stepId,
    attempt: failed.attemptView.attempt,
    iteration: failed.attemptView.iteration,
    logFilePath: failed.stepResult.log_file,
  };

  try {
    const result = await options.readStepLog(locator);
    if (result.success && result.data) {
      lines.push(formatPreformattedTextBlock(formatLogTail(result.data.lines)));
    } else {
      lines.push(`log read failed: ${result.error ?? 'unknown error'}`);
    }
  } catch (error: unknown) {
    lines.push(
      `log read failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  lines.push('');
}

async function appendLogTailsSection(
  lines: string[],
  state: ExecutionState,
  options: PipelineFailureDebugContextOptions,
  failedSteps: FailedStepInstance[],
): Promise<void> {
  lines.push('## Log Tails');
  if (failedSteps.length === 0) {
    lines.push('No failed step logs were available to load.', '');
    return;
  }

  for (const failed of failedSteps) {
    await appendLogTailForStep(lines, state, options, failed);
  }
}

function dirname(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return undefined;
  return normalized.slice(0, index);
}

function getExecutionOutputDirFromPath(path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/');
  const executionSegment = `/pipeline-executions/`;
  const executionIndex = normalized.indexOf(executionSegment);
  if (executionIndex === -1) return dirname(normalized);

  const afterExecutionRoot = normalized.slice(
    executionIndex + executionSegment.length,
  );
  const executionIdEnd = afterExecutionRoot.indexOf('/');
  if (executionIdEnd === -1) return dirname(normalized);

  return normalized.slice(
    0,
    executionIndex + executionSegment.length + executionIdEnd,
  );
}

function collectUsefulPaths(
  state: ExecutionState,
  failedSteps: FailedStepInstance[],
): string[] {
  const paths = new Set<string>();

  for (const path of [
    state.report_outputs?.report_file,
    state.report_outputs?.report_json_file,
    state.shared_pipeline_source?.cachedPipelinePath,
  ]) {
    if (path) paths.add(path);
  }

  for (const failed of failedSteps) {
    for (const path of [
      failed.stepResult.log_file,
      failed.stepResult.outputs.transcript_file,
      failed.stepResult.report_outputs?.report_file,
      failed.stepResult.report_outputs?.report_json_file,
    ]) {
      if (path) paths.add(path);
    }
  }

  return Array.from(paths);
}

function appendUsefulPathsSection(
  lines: string[],
  state: ExecutionState,
  failedSteps: FailedStepInstance[],
): void {
  const usefulPaths = collectUsefulPaths(state, failedSteps);
  const executionOutputDir =
    usefulPaths.map(getExecutionOutputDirFromPath).find(Boolean) ?? undefined;
  const executionJsonHint = executionOutputDir
    ? `${executionOutputDir}.json`
    : `pipeline-executions/${state.id}.json`;

  lines.push(
    '## Useful Paths',
    formatValueLine('execution JSON hint', executionJsonHint),
    formatValueLine('execution output directory', executionOutputDir),
    '',
  );

  if (usefulPaths.length === 0) {
    lines.push(
      'No concrete log/report/transcript paths were present in execution state.',
    );
    return;
  }

  for (const path of usefulPaths) {
    lines.push(`- ${path}`);
  }
}

export async function buildPipelineFailureDebugPrompt(
  state: ExecutionState,
  options: PipelineFailureDebugContextOptions,
): Promise<PipelineFailureDebugContextResult> {
  const failedSteps = collectFailedStepInstances(state);
  const lines: string[] = [INTRO_COPY, ''];

  appendExecutionSection(lines, state);
  appendTriggerSection(lines, state);
  appendPipelineSnapshotSection(lines, state);
  appendFailedStepsSection(lines, state, failedSteps);
  const includedReportKinds = await appendReportsSection(lines, state, options);
  await appendLogTailsSection(lines, state, options, failedSteps);
  appendUsefulPathsSection(lines, state, failedSteps);

  return {
    prompt: lines.join('\n'),
    failedStepCount: failedSteps.length,
    includedReportKinds,
  };
}
