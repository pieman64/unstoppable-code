'use client';

import { memo, useMemo, type JSX, type ReactNode } from 'react';
import {
  DagProgressBar,
  type DagJobMeta,
  type DagJobStatus,
} from '@canopy/ui-shared/components';
import {
  formatRelativeTime,
  statusBadgeClassName,
  type StatusBadgeTone,
} from '@canopy/ui-shared/lib';
import { ExternalLink } from '@canopy/ui-shared/icons/AppIcons';
import { githubWorkflowJobTiers } from './github-workflow-job-tiers';
import {
  githubWorkflowDefinitionTiers,
  type GitHubWorkflowRunRowGraph,
} from './github-workflow-definition-tiers';

/**
 * Structural mirror of the desktop `GitHubWorkflowRunState` union. Declared
 * here so this package stays free of `@canopy/desktop-shared`; the desktop
 * card maps its typed snapshot into this shape.
 */
export type GitHubWorkflowRunRowState =
  | { readonly kind: 'intermediate'; readonly status: string }
  | { readonly kind: 'terminal'; readonly conclusion: string }
  | {
      readonly kind: 'unsupported';
      readonly status: string | null;
      readonly conclusion: string | null;
      readonly terminal: boolean;
    };

export interface GitHubWorkflowRunRowJob {
  readonly jobId: string;
  readonly name: string;
  /** GitHub job status (`queued`, `in_progress`, `completed`, ...). */
  readonly status: string;
  readonly conclusion: string | null;
  readonly htmlUrl: string;
  /** GitHub's `created_at`; drives dependency-tier inference. */
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface GitHubWorkflowRunRowData {
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: number;
  readonly workflowName?: string;
  readonly runNumber?: number;
  readonly htmlUrl: string;
  readonly state: GitHubWorkflowRunRowState;
  readonly startedAt?: string;
  readonly observedAt: string;
  /** Absent until the watcher's first jobs read. */
  readonly jobs?: readonly GitHubWorkflowRunRowJob[];
  /**
   * The run's declared job graph, when its workflow definition was read.
   * Drives the tiers and shows jobs GitHub has not created yet as pending.
   */
  readonly definition?: GitHubWorkflowRunRowGraph;
}

export interface GitHubWorkflowRunRowStatus {
  /** Lower-case pill label matching the pipeline run pill vocabulary. */
  readonly label: string;
  readonly tone: StatusBadgeTone;
  readonly muted: boolean;
  /** True while GitHub still reports the run as not completed. */
  readonly active: boolean;
}

const INTERMEDIATE_LABELS: Readonly<Record<string, string>> = {
  requested: 'requested',
  queued: 'queued',
  pending: 'pending',
  waiting: 'waiting',
  in_progress: 'in progress',
};

const TERMINAL_LABELS: Readonly<Record<string, string>> = {
  action_required: 'action required',
  cancelled: 'cancelled',
  failure: 'failure',
  neutral: 'neutral',
  skipped: 'skipped',
  stale: 'stale',
  startup_failure: 'startup failure',
  success: 'success',
  timed_out: 'timed out',
};

function terminalTone(conclusion: string): StatusBadgeTone {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failed';
    case 'action_required':
      return 'warning';
    case 'cancelled':
      return 'paused';
    default:
      return 'neutral';
  }
}

/** Run state → status pill presentation. */
export function githubWorkflowRunRowStatus(
  state: GitHubWorkflowRunRowState,
): GitHubWorkflowRunRowStatus {
  if (state.kind === 'intermediate') {
    const label =
      INTERMEDIATE_LABELS[state.status] ?? state.status.replace(/_/g, ' ');
    return state.status === 'in_progress'
      ? { label, tone: 'active', muted: false, active: true }
      : { label, tone: 'paused', muted: true, active: true };
  }
  if (state.kind === 'terminal') {
    return {
      label:
        TERMINAL_LABELS[state.conclusion] ??
        state.conclusion.replace(/_/g, ' '),
      tone: terminalTone(state.conclusion),
      muted: false,
      active: false,
    };
  }
  const raw = state.terminal ? state.conclusion : state.status;
  return {
    label: raw
      ? raw.replace(/_/g, ' ')
      : state.terminal
        ? 'completed'
        : 'running',
    tone: 'neutral',
    muted: !state.terminal,
    active: !state.terminal,
  };
}

/** GitHub job status/conclusion → shared DAG dot status. */
export function githubWorkflowJobDagStatus(
  job: Pick<GitHubWorkflowRunRowJob, 'status' | 'conclusion'>,
): DagJobStatus | undefined {
  if (job.status === 'completed') {
    switch (job.conclusion) {
      case 'success':
        return 'success';
      case 'failure':
      case 'timed_out':
      case 'startup_failure':
        return 'failure';
      case 'cancelled':
        return 'cancelled';
      case 'skipped':
      case 'neutral':
      case 'stale':
        return 'skipped';
      case 'action_required':
        return 'paused';
      default:
        return undefined;
    }
  }
  if (job.status === 'in_progress') return 'running';
  if (
    job.status === 'queued' ||
    job.status === 'pending' ||
    job.status === 'waiting' ||
    job.status === 'requested'
  ) {
    return 'pending';
  }
  return undefined;
}

/** `CI #42 · attempt 2`, falling back to the run id when GitHub gave no name. */
export function githubWorkflowRunRowTitle(
  run: Pick<
    GitHubWorkflowRunRowData,
    'workflowName' | 'runNumber' | 'runId' | 'runAttempt'
  >,
): string {
  const workflowName = run.workflowName?.trim();
  const runRef =
    run.runNumber !== undefined ? `#${run.runNumber}` : `#${run.runId}`;
  const lead = workflowName ? `${workflowName} ${runRef}` : `Run ${runRef}`;
  return run.runAttempt > 1 ? `${lead} · attempt ${run.runAttempt}` : lead;
}

/**
 * A run's jobs as the DAG progress bar draws them: tiers from its declared
 * job graph when known, else inferred from when GitHub created each job.
 */
export function githubWorkflowRunDag(
  run: Pick<GitHubWorkflowRunRowData, 'definition' | 'jobs'>,
): { tiers: string[][]; jobs: Record<string, DagJobMeta> } {
  const observed = run.jobs ?? [];
  if (run.definition && run.definition.jobs.length > 0) {
    return githubWorkflowDefinitionTiers(run.definition, observed);
  }
  return {
    tiers: githubWorkflowJobTiers(observed),
    jobs: Object.fromEntries(
      observed.map((job) => [
        job.jobId,
        {
          jobId: job.jobId,
          name: job.name,
          status: githubWorkflowJobDagStatus(job),
          ...(job.startedAt ? { startedAt: job.startedAt } : {}),
          ...(job.completedAt ? { completedAt: job.completedAt } : {}),
        },
      ]),
    ),
  };
}

export interface GitHubWorkflowRunRowProps {
  run: GitHubWorkflowRunRowData;
  /** Opens the run on GitHub; the whole card is the affordance. */
  onOpen: () => void;
  /** Opens one job on GitHub when its progress dot is clicked. */
  onJobClick: (job: GitHubWorkflowRunRowJob) => void;
  renderWatcherButton?: () => ReactNode;
  dataTestId?: string;
}

/**
 * One watched GitHub Actions run, presented like an Agent activity pipeline
 * run: status pill, started time, workflow title, repository, and the shared
 * dot progress bar with one dot per job. With the run's workflow definition
 * the tiers follow the declared `needs` graph and jobs GitHub has not created
 * yet appear as pending dots (`githubWorkflowDefinitionTiers`); without it,
 * GitHub's jobs API has no dependency metadata, so tiers are inferred from
 * when GitHub created each job (`githubWorkflowJobTiers`).
 */
export const GitHubWorkflowRunRow = memo(function GitHubWorkflowRunRow({
  run,
  onOpen,
  onJobClick,
  renderWatcherButton,
  dataTestId,
}: GitHubWorkflowRunRowProps): JSX.Element {
  const status = githubWorkflowRunRowStatus(run.state);
  const jobs = run.jobs ?? [];
  const jobsById = Object.fromEntries(jobs.map((job) => [job.jobId, job]));
  const layout = useMemo(
    () => githubWorkflowRunDag({ definition: run.definition, jobs: run.jobs }),
    [run.definition, run.jobs],
  );
  return (
    <div
      data-testid={dataTestId ?? `github-workflow-run-card-${run.runId}`}
      data-run-status={status.label}
      className={
        status.active
          ? 'relative rounded-lg ring-1 ring-line-base bg-fg-primary/[0.03] px-3 py-3 transition-colors hover:ring-line-base hover:bg-fg-primary/[0.05]'
          : 'relative rounded-lg ring-1 ring-line-base/40 bg-fg-primary/[0.015] px-3 py-2.5 transition-colors hover:ring-line-base hover:bg-fg-primary/[0.03]'
      }
    >
      <button
        type="button"
        data-testid={`github-workflow-run-open-${run.runId}`}
        className="absolute inset-0 cursor-pointer rounded-lg"
        onClick={onOpen}
        aria-label={`Open ${githubWorkflowRunRowTitle(run)} on GitHub`}
      />
      <div className="pointer-events-none relative z-10 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={statusBadgeClassName(status.tone, {
                muted: status.muted || !status.active,
              })}
            >
              {status.label}
            </span>
            {run.startedAt ? (
              <span className="text-2xs fg-secondary/60">
                {formatRelativeTime(run.startedAt)}
              </span>
            ) : null}
            {renderWatcherButton ? (
              <span className="pointer-events-auto">
                {renderWatcherButton()}
              </span>
            ) : null}
          </div>
          <div
            className={`mt-1 truncate text-xs ${status.active ? 'font-medium fg-primary/80' : 'fg-secondary'}`}
          >
            {githubWorkflowRunRowTitle(run)}
          </div>
          <div className="truncate text-2xs fg-secondary/70">
            {run.repository}
          </div>
        </div>
        <span
          className="flex shrink-0 items-center gap-1 text-2xs fg-secondary/60"
          aria-hidden="true"
        >
          GitHub
          <ExternalLink size={12} aria-hidden="true" />
        </span>
      </div>
      {layout.tiers.length > 0 ? (
        <div className="relative z-10">
          <DagProgressBar
            tiers={layout.tiers}
            jobs={layout.jobs}
            muted={!status.active}
            onJobClick={(jobId): void => {
              // Placeholder dots for jobs GitHub has not created yet have
              // no page to open.
              const job = jobsById[jobId];
              if (job) onJobClick(job);
            }}
          />
        </div>
      ) : null}
    </div>
  );
});
