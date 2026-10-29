import type {
  GitHubWorkflowDefinitionGraph,
  GitHubWorkflowDefinitionSource,
  GitHubWorkflowJobSnapshot,
  GitHubWorkflowRunSnapshot,
  GitHubWorkflowRunState,
} from '@canopy/desktop-shared/types';
import { withJitter } from './github-broker/rate-limit';
import { fetchGitHubWorkflowDefinitionGraph } from './github-broker/workflow-definitions';
import {
  fetchGitHubWorkflowRun,
  fetchGitHubWorkflowRunJobs,
  type GitHubWorkflowRunJobsFetchResult,
} from './github-broker/workflow-runs';
import {
  GitHubResourceObserver,
  githubResourceBackoffDelayMs,
  githubResourceNextDelayMs,
  isPermanentGitHubSourceFailure,
  type GitHubObservedResource,
  type GitHubResourceAdapter,
} from './github-resource-observer';

const WORKFLOW_RUN_OBSERVER_CALLER = 'workflow-run-observer';

/** Definition reads attempted per resource before giving up for its lifetime. */
export const MAX_DEFINITION_READ_ATTEMPTS = 3;

export interface GitHubWorkflowRunWatcherSubscription {
  watcherId: string;
  repository: string;
  runId: string;
  requestedAttempt?: number;
  runAttempt: number;
  last: GitHubWorkflowRunSnapshot;
  /**
   * True when the watcher promised job-completion events, so a failed jobs
   * read must surface like any other source failure. Jobs are read for every
   * subscription regardless (they feed the chat's progress card); when no
   * subscriber requires them a failed read simply yields no jobs this cycle.
   */
  jobsRequired: boolean;
  jobs?: GitHubWorkflowJobSnapshot[];
  /**
   * True while the watcher still lacks the run's declared job graph; the
   * observer then reads the pinned workflow files best-effort on its next
   * cycles, from `definitionSource` when the persisted snapshot carries one
   * or from the freshly polled run otherwise.
   */
  wantsDefinition: boolean;
  definitionSource?: GitHubWorkflowDefinitionSource;
}

export type GitHubWorkflowRunObservationItem =
  | {
      kind: 'snapshot';
      subscriberIds?: readonly string[];
      repository: string;
      runId: string;
      requestedAttempt?: number;
      pinnedRunAttempt?: number;
      snapshot: GitHubWorkflowRunSnapshot;
      jobs?: GitHubWorkflowJobSnapshot[];
      definition?: GitHubWorkflowDefinitionGraph;
    }
  | {
      kind: 'source_failure';
      subscriberIds?: readonly string[];
      repository: string;
      runId: string;
      requestedAttempt?: number;
      pinnedRunAttempt?: number;
    }
  | {
      /** The broker holds this run's reads until `retryAt`. */
      kind: 'rate_limited';
      subscriberIds?: readonly string[];
      repository: string;
      runId: string;
      requestedAttempt?: number;
      pinnedRunAttempt?: number;
      retryAt: string;
    };

export interface GitHubWorkflowRunObservation {
  observations: GitHubWorkflowRunObservationItem[];
}

interface ObservedWorkflowRun extends GitHubObservedResource<GitHubWorkflowRunWatcherSubscription> {
  repository: string;
  runId: string;
  requestedAttempt?: number;
  pinnedRunAttempt: number;
  wantsDefinition: boolean;
  definitionSource?: GitHubWorkflowDefinitionSource;
  definitionAttempts: number;
  /** Set once a read succeeded so re-subscriptions never read it again. */
  definitionRead: boolean;
  definition?: GitHubWorkflowDefinitionGraph;
  lastSignature: string;
}

export const githubWorkflowRunBackoffDelayMs = githubResourceBackoffDelayMs;
export const githubWorkflowRunNextDelayMs = githubResourceNextDelayMs;

export function githubWorkflowRunStateSignature(options: {
  state: GitHubWorkflowRunState;
  runAttempt: number;
}): string {
  return JSON.stringify(options);
}

export function githubWorkflowRunPollDelayMs(
  snapshot: GitHubWorkflowRunSnapshot,
  changed: boolean,
): number {
  if (
    snapshot.state.kind === 'intermediate' &&
    snapshot.state.status === 'waiting'
  ) {
    return 15_000;
  }
  return changed ? 5_000 : 10_000;
}

function resourceKey(
  repository: string,
  runId: string,
  requestedAttempt?: number,
  pinnedRunAttempt?: number,
): string {
  return `${repository}/${runId}/${requestedAttempt ?? ''}/${pinnedRunAttempt ?? ''}`;
}

function isTerminalSnapshot(snapshot: GitHubWorkflowRunSnapshot): boolean {
  return (
    snapshot.state.kind === 'terminal' ||
    (snapshot.state.kind === 'unsupported' && snapshot.state.terminal)
  );
}

function runIdentity(resource: ObservedWorkflowRun): {
  repository: string;
  runId: string;
  requestedAttempt?: number;
  pinnedRunAttempt: number;
} {
  return {
    repository: resource.repository,
    runId: resource.runId,
    ...(resource.requestedAttempt
      ? { requestedAttempt: resource.requestedAttempt }
      : {}),
    pinnedRunAttempt: resource.pinnedRunAttempt,
  };
}

async function observeWorkflowRun(
  resource: ObservedWorkflowRun,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<GitHubWorkflowRunObservationItem[]> {
  const result = await fetchGitHubWorkflowRun({
    repository: resource.repository,
    runId: resource.runId,
    ...(resource.requestedAttempt
      ? { requestedAttempt: resource.requestedAttempt }
      : {}),
    priority: 'watcher',
    caller: WORKFLOW_RUN_OBSERVER_CALLER,
    signal,
  });
  let jobsResult: GitHubWorkflowRunJobsFetchResult | undefined;
  let jobsReadError: unknown;
  try {
    jobsResult = await fetchGitHubWorkflowRunJobs({
      repository: resource.repository,
      runId: resource.runId,
      runAttempt: resource.pinnedRunAttempt,
      priority: 'watcher',
      caller: WORKFLOW_RUN_OBSERVER_CALLER,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    jobsReadError = error;
  }
  let definition = resource.wantsDefinition ? resource.definition : undefined;
  const definitionSource =
    resource.definitionSource ?? result.snapshot.definitionSource;
  if (
    resource.wantsDefinition &&
    definitionSource &&
    !resource.definitionRead &&
    resource.definitionAttempts < MAX_DEFINITION_READ_ATTEMPTS
  ) {
    resource.definitionAttempts += 1;
    try {
      definition =
        (await fetchGitHubWorkflowDefinitionGraph({
          repository: resource.repository,
          source: definitionSource,
          priority: 'watcher',
          caller: WORKFLOW_RUN_OBSERVER_CALLER,
          signal,
        })) ?? undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      // Display-only: the run keeps being observed without it.
    }
    // Keep the bounded graph on the coalesced resource so a later
    // subscriber can receive it without another repository read.
    if (definition) {
      resource.definition = definition;
      resource.definitionRead = true;
    }
  }
  if (!isCurrent()) return [];
  const signature = githubWorkflowRunStateSignature({
    state: result.snapshot.state,
    runAttempt: result.snapshot.runAttempt,
  });
  const jobsSignature = jobsResult
    ? JSON.stringify(
        jobsResult.jobs.map((job) => [job.jobId, job.status, job.conclusion]),
      )
    : '';
  const combinedSignature = `${signature}:${jobsSignature}`;
  const changed = combinedSignature !== resource.lastSignature;
  resource.lastSignature = combinedSignature;
  const unsupportedNonTerminal =
    result.snapshot.state.kind === 'unsupported' &&
    !result.snapshot.state.terminal;
  const computedDelay = unsupportedNonTerminal
    ? githubResourceBackoffDelayMs(resource.errorCount++)
    : githubWorkflowRunPollDelayMs(result.snapshot, changed);
  if (!unsupportedNonTerminal) resource.errorCount = 0;
  resource.dueAt =
    Date.now() +
    githubResourceNextDelayMs(
      computedDelay,
      Math.max(result.pollIntervalMs ?? 0, jobsResult?.pollIntervalMs ?? 0) ||
        undefined,
    );
  const observations: GitHubWorkflowRunObservationItem[] = [];
  const deferTerminalSnapshot =
    jobsReadError !== undefined &&
    !isPermanentGitHubSourceFailure(jobsReadError) &&
    isTerminalSnapshot(result.snapshot);
  const runSnapshotSubscriberIds = deferTerminalSnapshot
    ? []
    : jobsReadError
      ? Array.from(resource.subscribers.entries())
          .filter(([, subscriber]) => !subscriber.jobsRequired)
          .map(([watcherId]) => watcherId)
      : Array.from(resource.subscribers.keys());
  if (runSnapshotSubscriberIds.length > 0) {
    observations.push({
      kind: 'snapshot',
      subscriberIds: runSnapshotSubscriberIds,
      ...runIdentity(resource),
      snapshot: result.snapshot,
      ...(jobsResult ? { jobs: jobsResult.jobs } : {}),
      ...(definition ? { definition } : {}),
    });
  }
  if (jobsReadError && isPermanentGitHubSourceFailure(jobsReadError)) {
    const jobsRequiredSubscriberIds = Array.from(resource.subscribers.entries())
      .filter(([, subscriber]) => subscriber.jobsRequired)
      .map(([watcherId]) => watcherId);
    if (jobsRequiredSubscriberIds.length > 0) {
      observations.push({
        kind: 'source_failure',
        subscriberIds: jobsRequiredSubscriberIds,
        ...runIdentity(resource),
      });
    }
  }
  return observations;
}

const workflowRunAdapter: GitHubResourceAdapter<
  GitHubWorkflowRunWatcherSubscription,
  ObservedWorkflowRun,
  GitHubWorkflowRunObservationItem
> = {
  resourceKey: (subscription) =>
    resourceKey(
      subscription.repository,
      subscription.runId,
      subscription.requestedAttempt,
      subscription.runAttempt,
    ),
  createResource: (key, entries, subscribers, now) => {
    const first = entries[0];
    return {
      key,
      repository: first.repository,
      runId: first.runId,
      ...(first.requestedAttempt
        ? { requestedAttempt: first.requestedAttempt }
        : {}),
      pinnedRunAttempt: first.runAttempt,
      wantsDefinition: entries.some((entry) => entry.wantsDefinition),
      definitionSource: entries.find((entry) => entry.definitionSource)
        ?.definitionSource,
      definitionAttempts: 0,
      definitionRead: false,
      subscribers,
      dueAt: now + withJitter(githubWorkflowRunPollDelayMs(first.last, true)),
      lastSignature: githubWorkflowRunStateSignature({
        state: first.last.state,
        runAttempt: first.last.runAttempt,
      }),
      errorCount: 0,
      inFlight: false,
    };
  },
  refreshResource: (resource, entries) => {
    resource.wantsDefinition = entries.some((entry) => entry.wantsDefinition);
    resource.definitionSource = entries.find(
      (entry) => entry.definitionSource,
    )?.definitionSource;
  },
  observe: observeWorkflowRun,
  sourceFailure: (resource) => [
    {
      kind: 'source_failure',
      subscriberIds: Array.from(resource.subscribers.keys()),
      ...runIdentity(resource),
    },
  ],
  rateLimited: (resource, retryAt, subscriberIds) => [
    {
      kind: 'rate_limited',
      subscriberIds: subscriberIds ?? Array.from(resource.subscribers.keys()),
      ...runIdentity(resource),
      retryAt: new Date(retryAt).toISOString(),
    },
  ],
};

export class GitHubWorkflowRunObserver extends GitHubResourceObserver<
  GitHubWorkflowRunWatcherSubscription,
  ObservedWorkflowRun,
  GitHubWorkflowRunObservationItem
> {
  constructor() {
    super(workflowRunAdapter);
  }
}

let singleton: GitHubWorkflowRunObserver | null = null;

export function getGitHubWorkflowRunObserver(): GitHubWorkflowRunObserver {
  singleton ??= new GitHubWorkflowRunObserver();
  return singleton;
}
