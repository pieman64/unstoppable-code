/** Frozen pre-phase-07 parser, validators and writer copied from watchers.ts at
 * pre-phase CURRENT HEAD 12439e38e24e44820d6ff7e7f5303056ee3ebcbb.
 * Do not replace these with imports from the live watcher service: this is the
 * downgrade oracle. Only the writer path is injected for test isolation.
 * Unrelated GitHub/delegate validators retain their original shared helpers.
 */
import type * as FileSystem from 'node:fs/promises';
const fs = jest.requireActual<typeof FileSystem>('node:fs/promises');
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  readCanonicalWatcherStore,
  writeCanonicalWatcherStore,
} from '../app-advisor/chat-watcher-storage';
import { randomUUID } from 'node:crypto';
import {
  type LocalWatcherEvent,
  LOCAL_WATCHER_LIMITS,
} from '@canopy/desktop-shared/types/local-watchers';
import { fsyncDirectory } from '../lib/fsync-directory';
import { stat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDelegationStopReason } from '@canopy/protocol/delegation';
import {
  type AppAdvisorWatcher,
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorGitHubWatcherRuntimeState,
  type GitHubWorkflowRunSnapshot,
  type GitHubWorkflowRunState,
  type GitHubWorkflowDefinitionSource,
  type GitHubWorkflowJobSnapshot,
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  type GitHubWorkflowDefinitionGraph,
  type GitHubWorkflowWatcherEvent,
  type GitHubWorkflowRunTransition,
  type AppAdvisorWatcherTarget,
  type AppAdvisorGitHubPullRequestWatcherRuntimeState,
  type AppAdvisorAutomationRunRuntimeState,
} from '@canopy/desktop-shared/types';
import type {
  GitHubPullRequestSnapshot,
  GitHubPullRequestWatcherEvent,
} from '@canopy/desktop-shared/types/github-watchers';
import {
  isPrMergeQueuePhase,
  type PrMergeQueueCursor,
  type PrMergeQueuePendingExit,
} from '@canopy/desktop-shared/types/github';
import {
  normalizeWatchGitHubItemsRequest,
  isPersistedGitHubPullRequestTarget,
} from '@canopy/desktop-shared/lib/app-advisor-watchers';
import { normalizeGitHubRepositoryReference } from '@canopy/desktop-shared/lib/github-workflow-run-references';
import {
  MAX_GITHUB_WORKFLOW_GRAPH_JOBS,
  MAX_GITHUB_WORKFLOW_GRAPH_NAMES,
} from '@canopy/desktop-shared/lib/github-workflow-definition-graph';

// Isolate the live setup service from host execution; the downgrade oracle below stays frozen.
let mockLegacyPath: string;
let mockDirectory: string;
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: (): string => mockLegacyPath,
  getDataDir: (): string => mockDirectory,
}));
// A slow watcher mutation records a chat-wait diagnostic; keep it from
// starting the real observability flush against the tiny paths mock above.
jest.mock('../observability', () => ({
  getObservabilityService: (): object => ({
    recordSessionDiagnostic: jest.fn(),
  }),
}));
jest.mock('../agents/session-manager', () => ({}));
jest.mock('../pipelines/pipeline-service', () => ({}));
jest.mock('../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => false,
}));
jest.mock('../lib/app-advisor-project-agent-access', () => ({}));
jest.mock('../lib/github-workflow-run-observer', () => ({}));
jest.mock('../lib/github-pull-request-observer', () => ({}));
jest.mock('../lib/github-pr-read-model', () => ({}));
jest.mock('../lib/github-broker', () => ({}));
jest.mock('../lib/github-broker/workflow-definitions', () => ({}));
jest.mock('../lib/github-broker/workflow-runs', () => ({}));
jest.mock('../lib/cowork-work-entries', () => ({}));
jest.mock('../lib/workspace-persistence', () => ({}));
jest.mock('../app-advisor/chat-watcher-access', () => ({
  resolveChatWatcherTarget: (entry: { target: object }): Promise<object> =>
    Promise.resolve(
      'botId' in entry.target
        ? { kind: 'bot', address: entry.target }
        : { kind: 'project', projectType: 'code', address: entry.target },
    ),
  decideChatWatcherAccess: (): Promise<object> =>
    Promise.resolve({
      allowed: true,
      sourceOwner: { kind: 'personal' },
      resourceIncarnation: 'stable',
    }),
}));
import { getAppAdvisorWatcherService } from '../app-advisor/watchers';

interface AppAdvisorWatchersFile {
  version: 1;
  updatedAt: string;
  watchers: AppAdvisorWatcher[];
}

const COMPLETED_STATUSES = new Set(['fired', 'delivery_failed']);

const COMPLETED_WATCHER_RETENTION_LIMIT = 200;

const TOOL_CALL_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

const MAX_GITHUB_EVENTS_PER_DELIVERY = 20;

const MAX_GITHUB_QUEUED_EVENTS = 500;

function githubPullRequestKey(target: {
  repository: string;
  number: number;
}): string {
  return `${target.repository}#${target.number}`;
}

interface WatchersFileSnapshot {
  path: string;
  signature: string;
  updatedAt: string;
  /** Validated rows as persisted; every read normalizes them again. */
  watchers: AppAdvisorWatcher[];
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

async function watchersFileSignature(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath, { bigint: true });
    return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function parseWatchersSnapshot(
  filePath: string,
  signature: string,
  raw: string,
): WatchersFileSnapshot | null {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.watchers)
  ) {
    return null;
  }
  return {
    path: filePath,
    signature,
    updatedAt:
      typeof parsed.updatedAt === 'string'
        ? parsed.updatedAt
        : new Date().toISOString(),
    // A store written before retention existed is bounded from its first
    // read; the next write persists the same rows.
    watchers: retainRecentCompletedWatchers(
      parsed.watchers.filter(isPersistedWatcher),
    ),
  };
}

function newestCompletedFirst(
  a: AppAdvisorWatcher,
  b: AppAdvisorWatcher,
): number {
  return (
    (Date.parse(b.firedAt ?? b.updatedAt) || 0) -
    (Date.parse(a.firedAt ?? a.updatedAt) || 0)
  );
}

function retainRecentCompletedWatchers(
  watchers: AppAdvisorWatcher[],
): AppAdvisorWatcher[] {
  const completed = watchers.filter((watcher) =>
    COMPLETED_STATUSES.has(watcher.status),
  );
  if (completed.length <= COMPLETED_WATCHER_RETENTION_LIMIT) return watchers;
  const retained = new Set(
    completed
      .sort(newestCompletedFirst)
      .slice(0, COMPLETED_WATCHER_RETENTION_LIMIT),
  );
  const receiptCutoff = Date.now() - TOOL_CALL_RECEIPT_RETENTION_MS;
  return watchers.filter(
    (watcher) =>
      !COMPLETED_STATUSES.has(watcher.status) ||
      retained.has(watcher) ||
      (nonBlank(watcher.createdByToolUseId) &&
        (Date.parse(watcher.firedAt ?? watcher.updatedAt) || 0) >=
          receiptCutoff),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isKnownWatcherStatus(
  value: unknown,
): value is AppAdvisorWatcher['status'] {
  return (
    value === 'active' ||
    value === 'firing' ||
    value === 'fired' ||
    value === 'delivery_failed'
  );
}

function isKnownWatcherTrigger(
  value: unknown,
): value is AppAdvisorWatcher['trigger'] | 'managed_delegation_completion' {
  return (
    value === 'worktree_chat_completion' ||
    value === 'standalone_chat_completion' ||
    value === 'worktree_new_chat_started' ||
    value === 'standalone_new_chat_started' ||
    value === 'worktree_pipeline_completion' ||
    value === 'worktree_hook_triggered' ||
    value === 'automation_run' ||
    value === 'github_workflow_runs_changed' ||
    value === 'github_pull_requests_changed' ||
    value === 'managed_delegation_completion' ||
    value === 'scheduled_wakeup' ||
    value === 'command_watch_resolved'
  );
}

function isGitHubWorkflowRunState(
  value: unknown,
): value is GitHubWorkflowRunState {
  if (!isRecord(value)) return false;
  if (value.kind === 'intermediate') {
    return (
      value.status === 'requested' ||
      value.status === 'queued' ||
      value.status === 'pending' ||
      value.status === 'waiting' ||
      value.status === 'in_progress'
    );
  }
  if (value.kind === 'terminal') {
    return (
      value.conclusion === 'action_required' ||
      value.conclusion === 'cancelled' ||
      value.conclusion === 'failure' ||
      value.conclusion === 'neutral' ||
      value.conclusion === 'skipped' ||
      value.conclusion === 'stale' ||
      value.conclusion === 'startup_failure' ||
      value.conclusion === 'success' ||
      value.conclusion === 'timed_out'
    );
  }
  return (
    value.kind === 'unsupported' &&
    (typeof value.status === 'string' || value.status === null) &&
    (typeof value.conclusion === 'string' || value.conclusion === null) &&
    typeof value.terminal === 'boolean'
  );
}

function isGitHubWorkflowRunSnapshot(
  value: unknown,
): value is GitHubWorkflowRunSnapshot {
  if (!isRecord(value) || !isGitHubWorkflowRunState(value.state)) return false;
  if (
    typeof value.runAttempt !== 'number' ||
    !Number.isInteger(value.runAttempt) ||
    value.runAttempt <= 0 ||
    typeof value.htmlUrl !== 'string' ||
    typeof value.observedAt !== 'string'
  ) {
    return false;
  }
  return (
    (value.workflowName === undefined ||
      typeof value.workflowName === 'string') &&
    (value.runNumber === undefined ||
      (typeof value.runNumber === 'number' &&
        Number.isInteger(value.runNumber) &&
        value.runNumber > 0)) &&
    (value.startedAt === undefined || typeof value.startedAt === 'string') &&
    (value.definitionSource === undefined ||
      isGitHubWorkflowDefinitionSource(value.definitionSource))
  );
}

function isGitHubWorkflowDefinitionSource(
  value: unknown,
): value is GitHubWorkflowDefinitionSource {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.sha === 'string' &&
    Array.isArray(value.referenced) &&
    value.referenced.length <= 20 &&
    value.referenced.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.repository === 'string' &&
        typeof entry.path === 'string' &&
        typeof entry.sha === 'string',
    )
  );
}

function isGitHubWorkflowDefinitionGraph(
  value: unknown,
): value is GitHubWorkflowDefinitionGraph {
  if (
    !isRecord(value) ||
    typeof value.sha !== 'string' ||
    typeof value.observedAt !== 'string' ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > MAX_GITHUB_WORKFLOW_GRAPH_JOBS
  ) {
    return false;
  }
  let names = 0;
  for (const job of value.jobs) {
    if (
      !isRecord(job) ||
      typeof job.id !== 'string' ||
      typeof job.template !== 'string' ||
      typeof job.dynamic !== 'boolean' ||
      !Array.isArray(job.names) ||
      !job.names.every((name) => typeof name === 'string') ||
      !Array.isArray(job.needs) ||
      !job.needs.every((need) => typeof need === 'string')
    ) {
      return false;
    }
    names += job.names.length;
  }
  return names <= MAX_GITHUB_WORKFLOW_GRAPH_NAMES;
}

function isGitHubWorkflowRunTransition(
  value: unknown,
): value is GitHubWorkflowRunTransition {
  if (!isRecord(value)) return false;
  return (
    typeof value.repository === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.runAttempt === 'number' &&
    Number.isInteger(value.runAttempt) &&
    value.runAttempt > 0 &&
    typeof value.url === 'string' &&
    isGitHubWorkflowRunState(value.previous) &&
    isGitHubWorkflowRunState(value.current) &&
    (value.workflowName === undefined ||
      typeof value.workflowName === 'string') &&
    (value.runNumber === undefined ||
      (typeof value.runNumber === 'number' &&
        Number.isInteger(value.runNumber)))
  );
}

function isGitHubWorkflowJobSnapshot(
  value: unknown,
): value is GitHubWorkflowJobSnapshot {
  return (
    isRecord(value) &&
    typeof value.jobId === 'string' &&
    /^[1-9]\d*$/.test(value.jobId) &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    (value.conclusion === null ||
      GITHUB_WORKFLOW_JOB_CONCLUSIONS.some(
        (conclusion) => conclusion === value.conclusion,
      )) &&
    typeof value.htmlUrl === 'string' &&
    (value.createdAt === undefined || typeof value.createdAt === 'string') &&
    (value.startedAt === undefined || typeof value.startedAt === 'string') &&
    (value.completedAt === undefined ||
      typeof value.completedAt === 'string') &&
    typeof value.observedAt === 'string'
  );
}

function isGitHubWorkflowWatcherEvent(
  value: unknown,
): value is GitHubWorkflowWatcherEvent {
  if (!isRecord(value)) return false;
  if (value.kind === 'workflow_run_transition') {
    return isGitHubWorkflowRunTransition(value);
  }
  if (value.kind !== 'workflow_job_completed' || !isRecord(value.job)) {
    return false;
  }
  const job = value.job;
  return (
    typeof value.repository === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.runAttempt === 'number' &&
    Number.isSafeInteger(value.runAttempt) &&
    value.runAttempt > 0 &&
    typeof job.id === 'string' &&
    /^[1-9]\d*$/.test(job.id) &&
    typeof job.name === 'string' &&
    GITHUB_WORKFLOW_JOB_CONCLUSIONS.some(
      (conclusion) => conclusion === job.conclusion,
    ) &&
    typeof job.url === 'string' &&
    (value.workflowName === undefined ||
      typeof value.workflowName === 'string') &&
    (value.runNumber === undefined ||
      (typeof value.runNumber === 'number' &&
        Number.isSafeInteger(value.runNumber) &&
        value.runNumber > 0))
  );
}

function isGitHubRuntimeState(
  value: unknown,
): value is AppAdvisorGitHubWatcherRuntimeState {
  if (!isRecord(value) || value.kind !== 'github_workflow_runs') return false;
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 20
  ) {
    return false;
  }
  if (
    !value.items.every(
      (item) =>
        isRecord(item) &&
        typeof item.key === 'string' &&
        typeof item.runAttempt === 'number' &&
        Number.isInteger(item.runAttempt) &&
        item.runAttempt > 0 &&
        isGitHubWorkflowRunSnapshot(item.last) &&
        (item.jobs === undefined ||
          (Array.isArray(item.jobs) &&
            item.jobs.length <= 500 &&
            item.jobs.every(isGitHubWorkflowJobSnapshot))) &&
        (item.definition === undefined ||
          isGitHubWorkflowDefinitionGraph(item.definition)) &&
        (item.settledAt === undefined || typeof item.settledAt === 'string'),
    )
  ) {
    return false;
  }
  if (
    value.queuedEvents !== undefined &&
    (!Array.isArray(value.queuedEvents) ||
      value.queuedEvents.length > MAX_GITHUB_QUEUED_EVENTS ||
      !value.queuedEvents.every(isGitHubWorkflowWatcherEvent))
  ) {
    return false;
  }
  if (
    value.consumeAfterQueuedDeliveries !== undefined &&
    typeof value.consumeAfterQueuedDeliveries !== 'boolean'
  ) {
    return false;
  }
  if (value.pendingDelivery === undefined) return true;
  if (!isRecord(value.pendingDelivery)) return false;
  const pending = value.pendingDelivery;
  const events = Array.isArray(pending.events) ? pending.events : null;
  const transitions = Array.isArray(pending.transitions)
    ? pending.transitions
    : null;
  return (
    typeof pending.eventId === 'string' &&
    typeof pending.observedAt === 'string' &&
    (events === null) !== (transitions === null) &&
    (events
      ? events.length > 0 &&
        events.length <= MAX_GITHUB_EVENTS_PER_DELIVERY &&
        events.every(isGitHubWorkflowWatcherEvent)
      : transitions !== null &&
        transitions.length > 0 &&
        transitions.length <= MAX_GITHUB_EVENTS_PER_DELIVERY &&
        transitions.every(isGitHubWorkflowRunTransition)) &&
    typeof pending.consumeAfterDelivery === 'boolean' &&
    typeof pending.attempts === 'number' &&
    Number.isInteger(pending.attempts) &&
    pending.attempts >= 0 &&
    typeof pending.nextAttemptAt === 'string'
  );
}

function isGitHubPullRequestSnapshot(
  value: unknown,
): value is GitHubPullRequestSnapshot {
  if (!isRecord(value)) return false;
  const queue = value.queue;
  return (
    (value.state === 'open' ||
      value.state === 'closed' ||
      value.state === 'merged') &&
    typeof value.url === 'string' &&
    (value.title === undefined || typeof value.title === 'string') &&
    typeof value.baseRefName === 'string' &&
    typeof value.headSha === 'string' &&
    (value.mergedAt === null || typeof value.mergedAt === 'string') &&
    (value.mergeCommitSha === null ||
      typeof value.mergeCommitSha === 'string') &&
    (value.closedAt === null || typeof value.closedAt === 'string') &&
    typeof value.observedAt === 'string' &&
    (queue === null ||
      (isRecord(queue) &&
        (queue.entryId === null || typeof queue.entryId === 'string') &&
        (queue.enqueuedAt === null || typeof queue.enqueuedAt === 'string') &&
        isPrMergeQueuePhase(queue.phase) &&
        (queue.position === null ||
          (typeof queue.position === 'number' &&
            Number.isSafeInteger(queue.position)))))
  );
}

function isGitHubPullRequestWatcherEvent(
  value: unknown,
): value is GitHubPullRequestWatcherEvent {
  if (
    !isRecord(value) ||
    typeof value.repository !== 'string' ||
    typeof value.number !== 'number' ||
    !Number.isSafeInteger(value.number) ||
    typeof value.url !== 'string' ||
    typeof value.baseBranch !== 'string' ||
    typeof value.headSha !== 'string'
  ) {
    return false;
  }
  switch (value.kind) {
    case 'pull_request_merged':
      return (
        typeof value.mergedAt === 'string' &&
        isNullableString(value.mergeCommitSha)
      );
    case 'pull_request_closed':
      return typeof value.closedAt === 'string';
    case 'pull_request_queue_removed':
      return (
        isNullableString(value.removedAt) &&
        isNullableString(value.reason) &&
        (value.evidence === 'timeline' ||
          value.evidence === 'entry_changed' ||
          value.evidence === 'membership') &&
        typeof value.requeued === 'boolean' &&
        (value.removals === undefined ||
          isIntegerInRange(value.removals, 2, Number.MAX_SAFE_INTEGER))
      );
    case 'pull_request_queue_entered':
      return (
        isNullableString(value.enqueuedAt) &&
        isPrMergeQueuePhase(value.phase) &&
        isNullableQueuePosition(value.position) &&
        typeof value.reentry === 'boolean'
      );
    case 'pull_request_queue_phase_changed':
      return (
        isPrMergeQueuePhase(value.previousPhase) &&
        isPrMergeQueuePhase(value.phase) &&
        isNullableQueuePosition(value.position)
      );
    case 'pull_request_queue_history_incomplete':
      return (
        typeof value.since === 'string' && typeof value.observedAt === 'string'
      );
    default:
      return false;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableQueuePosition(value: unknown): value is number | null {
  return value === null || isIntegerInRange(value, 0, Number.MAX_SAFE_INTEGER);
}

function isPrMergeQueueCursor(value: unknown): value is PrMergeQueueCursor {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isIntegerInRange(value.count, 0, Number.MAX_SAFE_INTEGER) &&
    isNullableString(value.lastEventId)
  );
}

function isPrMergeQueuePendingExit(
  value: unknown,
): value is PrMergeQueuePendingExit {
  return (
    isRecord(value) &&
    (value.heldFor === 'merged_reason' || value.heldFor === 'confirm') &&
    isNullableString(value.entryId) &&
    typeof value.observedAt === 'string' &&
    isIntegerInRange(value.samples, 0, Number.MAX_SAFE_INTEGER) &&
    isNullableString(value.removedAt) &&
    isNullableString(value.reason) &&
    (value.removals === undefined ||
      isIntegerInRange(value.removals, 2, Number.MAX_SAFE_INTEGER))
  );
}

function dropInvalidGitHubPullRequestQueueFields(
  item: Record<string, unknown>,
): void {
  if (item.queueCursor !== undefined && !isPrMergeQueueCursor(item.queueCursor))
    delete item.queueCursor;
  if (
    item.queuePendingExit !== undefined &&
    !isPrMergeQueuePendingExit(item.queuePendingExit)
  )
    delete item.queuePendingExit;
  if (
    item.queueHistoryGapSince !== undefined &&
    typeof item.queueHistoryGapSince !== 'string'
  )
    delete item.queueHistoryGapSince;
}

function isGitHubPullRequestRuntimeState(
  value: unknown,
  target: Extract<AppAdvisorWatcherTarget, { kind: 'github_pull_requests' }>,
): value is AppAdvisorGitHubPullRequestWatcherRuntimeState {
  if (
    !isRecord(value) ||
    value.kind !== 'github_pull_requests' ||
    !Array.isArray(value.items) ||
    value.items.length !== target.items.length
  ) {
    return false;
  }
  const targetKeys = new Set(target.items.map(githubPullRequestKey));
  if (
    !value.items.every((item) => {
      if (
        !isRecord(item) ||
        typeof item.key !== 'string' ||
        !targetKeys.delete(item.key) ||
        !isGitHubPullRequestSnapshot(item.last) ||
        (item.settledAt !== undefined && typeof item.settledAt !== 'string') ||
        (item.settledAs !== undefined &&
          item.settledAs !== 'merged' &&
          item.settledAs !== 'closed')
      ) {
        return false;
      }
      dropInvalidGitHubPullRequestQueueFields(item);
      return true;
    }) ||
    (value.queuedEvents !== undefined &&
      (!Array.isArray(value.queuedEvents) ||
        value.queuedEvents.length > MAX_GITHUB_QUEUED_EVENTS ||
        !value.queuedEvents.every(isGitHubPullRequestWatcherEvent))) ||
    (value.consumeAfterQueuedDeliveries !== undefined &&
      typeof value.consumeAfterQueuedDeliveries !== 'boolean') ||
    (value.sourceFailure !== undefined &&
      typeof value.sourceFailure !== 'string')
  ) {
    return false;
  }
  const pending = value.pendingDelivery;
  return (
    pending === undefined ||
    (isRecord(pending) &&
      typeof pending.eventId === 'string' &&
      typeof pending.observedAt === 'string' &&
      Array.isArray(pending.events) &&
      pending.events.length > 0 &&
      pending.events.length <= MAX_GITHUB_EVENTS_PER_DELIVERY &&
      pending.events.every(isGitHubPullRequestWatcherEvent) &&
      typeof pending.consumeAfterDelivery === 'boolean' &&
      isIntegerInRange(pending.attempts, 0, Number.MAX_SAFE_INTEGER) &&
      typeof pending.nextAttemptAt === 'string')
  );
}

function isWatcherCommandOutput(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isIntegerInRange(value.byteSize, 0, LOCAL_WATCHER_LIMITS.maxBytes) ||
    !isIntegerInRange(value.lineCount, 0, Number.MAX_SAFE_INTEGER) ||
    typeof value.complete !== 'boolean'
  ) {
    return false;
  }
  return value.kind === 'inline'
    ? typeof value.text === 'string'
    : value.kind === 'file' &&
        typeof value.path === 'string' &&
        (value.scriptId === undefined || typeof value.scriptId === 'string');
}

function isLocalWatcherEvent(value: unknown): value is LocalWatcherEvent {
  return (
    isRecord(value) &&
    value.type === 'local_watcher_resolved' &&
    (value.outcome === 'success' || value.outcome === 'failure') &&
    typeof value.reason === 'string' &&
    isIntegerInRange(value.attempts, 0, LOCAL_WATCHER_LIMITS.maxAttempts) &&
    typeof value.completedAt === 'string' &&
    Number.isFinite(Date.parse(value.completedAt)) &&
    (value.exitCode === undefined ||
      value.exitCode === null ||
      (typeof value.exitCode === 'number' &&
        Number.isInteger(value.exitCode))) &&
    (value.signal === undefined ||
      value.signal === null ||
      typeof value.signal === 'string') &&
    (value.output === undefined || isWatcherCommandOutput(value.output))
  );
}

function isDelegateWatchEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonBlank(value.watcherId) &&
    (value.outcome === 'completed' || value.outcome === 'timeout') &&
    (value.mode === 'any' || value.mode === 'all') &&
    typeof value.deadlineAt === 'number' &&
    Number.isSafeInteger(value.deadlineAt) &&
    Array.isArray(value.targets) &&
    value.targets.length >= 1 &&
    value.targets.length <= 16 &&
    value.targets.every(
      (target) =>
        isRecord(target) &&
        nonBlank(target.delegationId) &&
        isIntegerInRange(target.runGeneration, 1, Number.MAX_SAFE_INTEGER) &&
        typeof target.status === 'string' &&
        (target.resultIndex === null ||
          isIntegerInRange(target.resultIndex, 1, Number.MAX_SAFE_INTEGER)) &&
        (target.exitReason === undefined ||
          isDelegationStopReason(target.exitReason)),
    )
  );
}

function isManagedDelegationRuntimeState(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.kind !== 'managed_delegation' ||
    !nonBlank(value.nextAttemptAt) ||
    !Number.isFinite(Date.parse(value.nextAttemptAt)) ||
    !nonBlank(value.requestHash) ||
    !nonBlank(value.invocationKey) ||
    !isRecord(value.recipient) ||
    (value.recipient.kind !== 'root' && value.recipient.kind !== 'delegate') ||
    (value.recipient.kind === 'delegate' &&
      !nonBlank(value.recipient.delegationId)) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 16
  )
    return false;
  if (
    !value.targets.every(
      (target) =>
        isRecord(target) &&
        nonBlank(target.delegationId) &&
        isIntegerInRange(target.runGeneration, 1, Number.MAX_SAFE_INTEGER) &&
        typeof target.status === 'string' &&
        (target.resultIndex === null ||
          isIntegerInRange(target.resultIndex, 1, Number.MAX_SAFE_INTEGER)) &&
        (target.settledAt === undefined ||
          (typeof target.settledAt === 'number' &&
            Number.isSafeInteger(target.settledAt))),
    )
  )
    return false;
  return (
    (value.cancellationPending === undefined ||
      (isRecord(value.cancellationPending) &&
        (value.cancellationPending.previousStatus === 'active' ||
          value.cancellationPending.previousStatus === 'firing'))) &&
    (value.pendingDelivery === undefined ||
      (isRecord(value.pendingDelivery) &&
        nonBlank(value.pendingDelivery.eventId) &&
        isIntegerInRange(
          value.pendingDelivery.attempts,
          0,
          Number.MAX_SAFE_INTEGER,
        ) &&
        isDelegateWatchEvent(value.pendingDelivery.event)))
  );
}

interface PersistedGitHubWorkflowRunItem {
  kind: 'workflow_run';
  repository: string;
  runId: string;
  requestedAttempt?: number;
}

const PERSISTED_GITHUB_ITEM_KEYS = new Set([
  'kind',
  'repository',
  'runId',
  'requestedAttempt',
]);

function isCanonicalGitHubRunId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 20 || !/^\d+$/.test(value)) {
    return false;
  }
  try {
    const numeric = BigInt(value);
    return numeric > BigInt(0) && numeric.toString() === value;
  } catch {
    return false;
  }
}

function isPersistedGitHubWorkflowRunItem(
  value: unknown,
): value is PersistedGitHubWorkflowRunItem {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !PERSISTED_GITHUB_ITEM_KEYS.has(key)) ||
    value.kind !== 'workflow_run' ||
    typeof value.repository !== 'string' ||
    normalizeGitHubRepositoryReference(value.repository) !== value.repository ||
    !isCanonicalGitHubRunId(value.runId)
  ) {
    return false;
  }
  return (
    value.requestedAttempt === undefined ||
    (typeof value.requestedAttempt === 'number' &&
      Number.isSafeInteger(value.requestedAttempt) &&
      value.requestedAttempt > 0)
  );
}

function isPersistedGitHubTarget(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== 'github_workflow_runs') return false;
  const notifyOn = isRecord(value.notifyOn) ? value.notifyOn : null;
  if (!notifyOn) return false;
  const statuses = Array.isArray(notifyOn.statuses) ? notifyOn.statuses : null;
  const conclusions = Array.isArray(notifyOn.conclusions)
    ? notifyOn.conclusions
    : null;
  const jobConclusions = Array.isArray(notifyOn.jobConclusions)
    ? notifyOn.jobConclusions
    : [];
  if (
    !statuses ||
    !conclusions ||
    statuses.length + conclusions.length + jobConclusions.length === 0
  ) {
    return false;
  }
  const items = Array.isArray(value.items) ? value.items : null;
  if (
    !items ||
    items.length === 0 ||
    items.length > 20 ||
    !items.every(isPersistedGitHubWorkflowRunItem) ||
    new Set(
      items.map(
        (item) =>
          `${item.repository}/${item.runId}/${item.requestedAttempt ?? ''}`,
      ),
    ).size !== items.length
  ) {
    return false;
  }
  const normalized = normalizeWatchGitHubItemsRequest({
    items: items.map((item) => ({
      kind: item.kind,
      repository: item.repository,
      runId: item.runId,
      ...(item.requestedAttempt !== undefined
        ? { runAttempt: item.requestedAttempt }
        : {}),
    })),
    notifyOn: {
      ...(statuses.length > 0 ? { statuses } : {}),
      ...(conclusions.length > 0 ? { conclusions } : {}),
      ...(jobConclusions.length > 0
        ? { jobs: { conclusions: jobConclusions } }
        : {}),
    },
  });
  if (!normalized.ok || !isRecord(value.display)) return false;
  return (
    Array.isArray(value.display.repositories) &&
    value.display.repositories.length <= 20 &&
    value.display.repositories.every((entry) => typeof entry === 'string') &&
    Array.isArray(value.display.sample) &&
    value.display.sample.length <= 5 &&
    value.display.sample.every(
      (sample) =>
        isRecord(sample) &&
        typeof sample.repository === 'string' &&
        typeof sample.runId === 'string' &&
        (sample.runAttempt === undefined ||
          (typeof sample.runAttempt === 'number' &&
            Number.isSafeInteger(sample.runAttempt) &&
            sample.runAttempt > 0)) &&
        (sample.workflowName === undefined ||
          typeof sample.workflowName === 'string') &&
        (sample.runNumber === undefined ||
          (typeof sample.runNumber === 'number' &&
            Number.isInteger(sample.runNumber))),
    )
  );
}

function isPersistedWatcher(value: unknown): value is AppAdvisorWatcher {
  if (!isRecord(value)) return false;
  if (
    value.executionContext !== undefined &&
    typeof value.executionContext !== 'string'
  )
    return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== 'string') return false;
  if (!isKnownWatcherTrigger(value.trigger)) return false;
  if (!isKnownWatcherStatus(value.status)) return false;
  if (typeof value.label !== 'string') return false;
  if (!isRecord(value.target) || typeof value.target.kind !== 'string') {
    return false;
  }
  if (
    !isRecord(value.destination) ||
    typeof value.destination.projectId !== 'string' ||
    typeof value.destination.worktreeId !== 'string' ||
    typeof value.destination.chatId !== 'string' ||
    (value.destination.delegationId !== undefined &&
      (!nonBlank(value.destination.delegationId) ||
        value.destination.projectId === APP_ADVISOR_PROJECT_ID))
  ) {
    return false;
  }
  if (typeof value.createdAt !== 'string') return false;
  if (typeof value.updatedAt !== 'string') return false;
  if (typeof value.dedupeKey !== 'string') return false;
  if (
    value.executionScope !== undefined &&
    (!isRecord(value.executionScope) ||
      !nonBlank(value.executionScope.projectId) ||
      !nonBlank(value.executionScope.worktreeId) ||
      !nonBlank(value.executionScope.createdAt))
  ) {
    return false;
  }
  if (
    value.failureKind !== undefined &&
    value.failureKind !== 'delivery' &&
    value.failureKind !== 'source'
  ) {
    return false;
  }
  if (value.pendingLocalDelivery !== undefined) {
    const pending = value.pendingLocalDelivery;
    if (
      !isRecord(pending) ||
      typeof pending.deliveryId !== 'string' ||
      typeof pending.text !== 'string' ||
      typeof pending.hiddenContextText !== 'string' ||
      typeof pending.firedKind !== 'string' ||
      typeof pending.consume !== 'boolean' ||
      (pending.pipelineExecutionId !== undefined &&
        typeof pending.pipelineExecutionId !== 'string') ||
      (pending.pipelineTransitionKey !== undefined &&
        typeof pending.pipelineTransitionKey !== 'string') ||
      (pending.appAdvisorPrompt !== undefined &&
        pending.appAdvisorPrompt !== true)
    )
      return false;
  }
  if (
    value.observedPipelinePauses !== undefined &&
    (!isRecord(value.observedPipelinePauses) ||
      !Object.values(value.observedPipelinePauses).every(
        (entry) => typeof entry === 'string',
      ))
  )
    return false;
  const isGitHubTrigger = value.trigger === 'github_workflow_runs_changed';
  if (value.trigger === 'managed_delegation_completion') {
    return (
      value.target.kind === 'managed_delegation' &&
      isManagedDelegationRuntimeState(value.runtimeState)
    );
  }
  if (
    value.trigger === 'scheduled_wakeup' ||
    value.trigger === 'command_watch_resolved'
  ) {
    const target = value.target;
    const state = value.runtimeState;
    return (
      isRecord(state) &&
      state.kind === 'local_watcher' &&
      isIntegerInRange(state.attempts, 0, Number.MAX_SAFE_INTEGER) &&
      typeof state.nextAttemptAt === 'string' &&
      Number.isFinite(Date.parse(state.nextAttemptAt)) &&
      (state.running === undefined || typeof state.running === 'boolean') &&
      (state.cancellationPending === undefined ||
        (isRecord(state.cancellationPending) &&
          (state.cancellationPending.previousStatus === 'active' ||
            state.cancellationPending.previousStatus === 'firing') &&
          (state.cancellationPending.scope === undefined ||
            (isRecord(state.cancellationPending.scope) &&
              nonBlank(state.cancellationPending.scope.projectId) &&
              nonBlank(state.cancellationPending.scope.worktreeId) &&
              (state.cancellationPending.scope.createdAt === undefined ||
                nonBlank(state.cancellationPending.scope.createdAt)))))) &&
      (state.pendingDelivery === undefined ||
        (isRecord(state.pendingDelivery) &&
          nonBlank(state.pendingDelivery.eventId) &&
          isIntegerInRange(
            state.pendingDelivery.attempts,
            0,
            Number.MAX_SAFE_INTEGER,
          ) &&
          isLocalWatcherEvent(state.pendingDelivery.event))) &&
      (value.trigger === 'scheduled_wakeup'
        ? target.kind === 'scheduled_wakeup' &&
          typeof target.scheduledFor === 'string' &&
          Number.isFinite(Date.parse(target.scheduledFor))
        : target.kind === 'command_watch' &&
          nonBlank(target.command) &&
          nonBlank(target.cwd) &&
          isIntegerInRange(target.intervalSeconds, 5, 3600) &&
          isIntegerInRange(target.maxAttempts, 1, 100))
    );
  }
  if (
    value.target.kind === 'scheduled_wakeup' ||
    value.target.kind === 'command_watch'
  )
    return false;
  const isGitHubTarget = isPersistedGitHubTarget(value.target);
  const isGitHubRuntime = isGitHubRuntimeState(value.runtimeState);
  if (isGitHubTrigger) {
    return isGitHubTarget && isGitHubRuntime;
  }
  if (isGitHubTarget) return false;
  if (value.trigger === 'github_pull_requests_changed') {
    return (
      isPersistedGitHubPullRequestTarget(value.target) &&
      isGitHubPullRequestRuntimeState(value.runtimeState, value.target)
    );
  }
  if (value.target.kind === 'github_pull_requests') return false;
  if (value.runtimeState === undefined) return true;
  return (
    value.trigger === 'automation_run' &&
    isAutomationRuntimeState(value.runtimeState)
  );
}

function isAutomationRuntimeState(
  value: unknown,
): value is AppAdvisorAutomationRunRuntimeState {
  if (!isRecord(value) || value.kind !== 'automation_run') return false;
  const pending = value.pendingCorrelation;
  if (!isRecord(pending)) return false;
  if (
    typeof pending.runId !== 'string' ||
    typeof pending.activityName !== 'string' ||
    typeof pending.manual !== 'boolean' ||
    typeof pending.recordedAt !== 'string'
  ) {
    return false;
  }
  if (pending.chat !== undefined) {
    const chat = pending.chat;
    if (
      !isRecord(chat) ||
      (chat.scope !== 'worktree' && chat.scope !== 'standalone') ||
      typeof chat.projectId !== 'string' ||
      typeof chat.chatId !== 'string' ||
      (chat.worktreeId !== undefined && typeof chat.worktreeId !== 'string')
    ) {
      return false;
    }
  }
  return (
    pending.pipelineExecutionId === undefined ||
    typeof pending.pipelineExecutionId === 'string'
  );
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

class FrozenPrePhaseStore {
  public snapshotLoad: null = null;
  public snapshot: WatchersFileSnapshot | null = null;
  public constructor(private readonly filePath: string) {}
  public async writeFile(file: AppAdvisorWatchersFile): Promise<void> {
    const filePath = this.filePath;
    const dir = dirname(filePath);
    await mkdir(dir, { recursive: true });
    const updatedFile: AppAdvisorWatchersFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      watchers: retainRecentCompletedWatchers(file.watchers),
    };
    const serialized = `${JSON.stringify(updatedFile)}\n`;
    const tempPath = join(
      dir,
      `.app-advisor-watchers-${process.pid}-${randomUUID()}.tmp`,
    );
    let renamed = false;
    try {
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(serialized, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, filePath);
      renamed = true;
      await fsyncDirectory(dir);
    } finally {
      if (!renamed) {
        await unlink(tempPath).catch(() => undefined);
      }
    }
    // Parse what was written, so the snapshot holds exactly what a read of
    // the file would produce without reading it back.
    const signature = await watchersFileSignature(filePath);
    this.snapshotLoad = null;
    this.snapshot =
      signature === null
        ? null
        : parseWatchersSnapshot(filePath, signature, serialized);
  }
}

const STAMP = '2026-10-16T00:00:00.000Z';
function pending(deliveryId: string): Record<string, unknown> {
  return {
    deliveryId,
    text: 'immutable notification',
    hiddenContextText: 'immutable context',
    firedKind: 'chat_completion',
    consume: true,
    futureOutboxField: { retained: true },
  };
}
function legacyRow(id: string): AppAdvisorWatcher {
  return {
    version: 1,
    id,
    trigger: 'worktree_chat_completion',
    status: 'active',
    label: id,
    target: {
      kind: 'worktree_chat',
      projectId: 'project',
      worktreeId: 'task',
      chatId: 'chat',
    },
    destination: {
      projectId: 'recipient-project',
      worktreeId: 'recipient-task',
      chatId: 'recipient-chat',
      delegationId: 'delegate',
    },
    createdAt: STAMP,
    updatedAt: STAMP,
    dedupeKey: `original-${id}`,
  };
}
function parseFrozen(raw: string): AppAdvisorWatcher[] {
  return parseWatchersSnapshot('test', 'test-signature', raw)?.watchers ?? [];
}

describe('canonical watcher sidecar and frozen pre-phase downgrade', () => {
  let directory: string;
  let legacyPath: string;
  let canonicalPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canonical-watcher-'));
    legacyPath = join(directory, 'app-advisor-watchers.json');
    canonicalPath = join(directory, 'app-advisor-watchers-canonical.json');
    mockLegacyPath = legacyPath;
    mockDirectory = directory;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  test('pending inline reservations remain opaque and inert through old reader/writer round trip', async () => {
    const service = getAppAdvisorWatcherService();
    const reservation = await service.reserveInlineChatWatchers({
      destination: {
        projectId: 'recipient',
        worktreeId: 'task',
        chatId: 'root',
      },
      recipient: { kind: 'root' },
      createdByToolUseId: 'send-tool',
      target: { projectId: 'source', taskId: 'task', chatId: 'source-chat' },
      entries: [{}],
      acceptedInputId: 'reserved-input',
      commandId: 'send-command',
    });
    if (!reservation.ok) throw new Error(reservation.error);
    const before = await readFile(canonicalPath, 'utf8');
    const pending = await readCanonicalWatcherStore(canonicalPath);
    const observation: unknown = expect.objectContaining({
      boundInputId: 'reserved-input',
    });
    const watcher: unknown = expect.objectContaining({
      createdByToolUseId: 'send-tool',
      observation,
    });
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'inline_chat_pending_watcher',
          watcher,
        }),
        expect.objectContaining({
          kind: 'inline_chat_reservation',
          state: 'pending',
        }),
      ]),
    );
    // Old matchers cannot see the reservation or the executable watcher inside its wrapper.
    expect(
      parseFrozen(JSON.stringify({ version: 1, watchers: pending })),
    ).toEqual([]);
    const oldRows = parseFrozen(await readFile(legacyPath, 'utf8'));
    expect(oldRows).toEqual([]);
    await new FrozenPrePhaseStore(legacyPath).writeFile({
      version: 1,
      updatedAt: STAMP,
      watchers: [legacyRow('old-unrelated')],
    });
    expect(await readFile(canonicalPath, 'utf8')).toBe(before);
    // The phase-07 sidecar writer also preserves unknown wrapper rows verbatim.
    await writeCanonicalWatcherStore(
      canonicalPath,
      await readCanonicalWatcherStore(canonicalPath),
    );
    expect(await readCanonicalWatcherStore(canonicalPath)).toEqual(pending);
    expect((await service.list()).map((row) => row.id)).toContain(
      reservation.reservation.receipts[0]?.watcherId,
    );
    await service.confirmInlineChatWatchers(
      reservation.reservation.reservationId,
      {
        acceptedInputId: 'reserved-input',
        disposition: 'queued',
        queuedMessageId: 'queue',
        acceptedAt: STAMP,
      },
    );
    const confirmed = await readCanonicalWatcherStore(canonicalPath);
    expect(confirmed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reservation.reservation.receipts[0]?.watcherId,
          status: 'active',
        }),
      ]),
    );
    expect(
      confirmed.some(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          'kind' in row &&
          row.kind === 'inline_chat_pending_watcher',
      ),
    ).toBe(false);
  });

  test('completed live setup survives frozen old deletion of the batch witness', async () => {
    const service = getAppAdvisorWatcherService();
    const recipient = {
      destination: {
        projectId: 'recipient',
        worktreeId: 'task',
        chatId: 'subscriber',
      },
      recipient: { kind: 'root' as const },
    };
    const result = await service.setupCanonicalChatWatchers({
      ...recipient,
      watchers: [
        {
          trigger: 'project_new_chat_started',
          target: { projectId: 'project', taskId: 'task' },
        },
        { trigger: 'bot_new_chat_started', target: { botId: 'app_advisor' } },
      ],
    });
    if (!result.ok) throw new Error(result.error);
    const oldRows = parseFrozen(await readFile(legacyPath, 'utf8'));
    expect(oldRows).toHaveLength(1);
    expect(typeof Reflect.get(oldRows[0], 'chatWatcherBatchId')).toBe('string');
    // Frozen deleteWatcher commits precisely this filtered v1 snapshot.
    await new FrozenPrePhaseStore(legacyPath).writeFile({
      version: 1,
      updatedAt: STAMP,
      watchers: oldRows.filter(
        (row) => row.id !== result.results[0].watcher.id,
      ),
    });
    expect(
      (await service.projectCanonicalChatWatchers(recipient)).map(
        (row) => row.id,
      ),
    ).toEqual([result.results[1].watcher.id]);
  });

  test('new write → frozen old read → unrelated old write → new read retains canonical facts and both outboxes', async () => {
    const compatible = {
      ...legacyRow('compatible'),
      chatWatcherBatchId: 'mixed-batch-witness',
      canonical: {
        trigger: 'project_task_chat_completion',
        target: { projectId: 'project', taskId: 'task', chatId: 'chat' },
        futureCanonicalFact: { epoch: 7 },
      },
      observation: { mode: 'current', boundInputId: 'input', armedAt: STAMP },
      evidence: { sourceOwner: { kind: 'personal' }, futureEvidence: 1 },
      pendingLocalDelivery: pending('compatible-delivery'),
      futureRowField: { keep: true },
    };
    const unrelated = legacyRow('unrelated');
    const sidecarRows = [
      {
        ...legacyRow('bot'),
        trigger: 'bot_task_chat_completion',
        target: {
          kind: 'bot_task_chat',
          botId: 'app_advisor',
          taskId: 'bot-task',
          chatId: 'bot-chat',
        },
        canonical: {
          trigger: 'bot_task_chat_completion',
          target: {
            botId: 'app_advisor',
            taskId: 'bot-task',
            chatId: 'bot-chat',
          },
        },
        pendingLocalDelivery: pending('bot-delivery'),
      },
      {
        ...legacyRow('project-wide'),
        trigger: 'project_new_chat_started',
        target: { kind: 'project_chat_scope', projectId: 'project' },
        canonical: {
          trigger: 'project_new_chat_started',
          target: { projectId: 'project' },
        },
        pendingLocalDelivery: pending('project-wide-delivery'),
      },
      {
        ...legacyRow('cowork-task'),
        trigger: 'project_new_chat_started',
        target: {
          kind: 'project_chat_scope',
          projectId: 'cowork',
          taskId: 'entry',
        },
        canonical: {
          trigger: 'project_new_chat_started',
          target: { projectId: 'cowork', taskId: 'entry' },
        },
        pendingLocalDelivery: pending('cowork-task-delivery'),
      },
      {
        kind: 'chat_delivery_authority',
        watcher: {
          ...legacyRow('queued-authority'),
          chatDeliveryId: 'queued-delivery',
        },
      },
      {
        kind: 'chat_delivery_authority',
        released: true,
        releasedAt: STAMP,
        watcher: {
          ...legacyRow('released-authority'),
          chatDeliveryId: 'released-delivery',
        },
      },
      { version: 99, futureUnrecognizedRow: { outbox: 'must remain' } },
    ];
    // New writer creates the isolated sidecar; the legacy-compatible shape is
    // deliberately the same v1 envelope the live service writes.
    await writeFile(
      legacyPath,
      JSON.stringify({
        version: 1,
        updatedAt: STAMP,
        watchers: [compatible, unrelated],
      }),
    );
    await writeCanonicalWatcherStore(canonicalPath, sidecarRows);
    const sidecarBytes = await readFile(canonicalPath, 'utf8');
    const oldRows = parseFrozen(await readFile(legacyPath, 'utf8'));
    expect(oldRows.map((row) => row.id)).toEqual(['compatible', 'unrelated']);
    expect(oldRows[0]).toEqual(compatible);
    const other = oldRows.find((row) => row.id === 'unrelated');
    if (!other) throw new Error('Frozen old parser lost unrelated watcher');
    other.label = 'an unrelated old-binary change';
    await new FrozenPrePhaseStore(legacyPath).writeFile({
      version: 1,
      updatedAt: STAMP,
      watchers: oldRows,
    });
    const reloaded = parseFrozen(await readFile(legacyPath, 'utf8'));
    expect(reloaded[0]).toEqual(compatible);
    expect(reloaded[1]?.label).toBe('an unrelated old-binary change');
    expect(await readFile(canonicalPath, 'utf8')).toBe(sidecarBytes);
    expect(await readCanonicalWatcherStore(canonicalPath)).toEqual(sidecarRows);
    // Contrast: these new-only rows would be destructively filtered if mixed
    // into v1. This assertion pins the real old allowlist, not a new parser.
    expect(
      parseFrozen(
        JSON.stringify({
          version: 1,
          watchers: [compatible, ...sidecarRows, unrelated],
        }),
      ).map((row) => row.id),
    ).toEqual(['compatible', 'unrelated']);
  });

  test('frozen old roundtrip also preserves unrelated automation runtime state and its pending correlation', async () => {
    const automation = {
      ...legacyRow('automation'),
      trigger: 'automation_run',
      target: { kind: 'automation', automationId: 'automation' },
      runtimeState: {
        kind: 'automation_run',
        pendingCorrelation: {
          runId: 'run',
          activityName: 'activity',
          manual: false,
          recordedAt: STAMP,
          chat: {
            scope: 'worktree',
            projectId: 'project',
            worktreeId: 'task',
            chatId: 'chat',
          },
        },
        futureRuntimeValue: { keep: true },
      },
      pendingLocalDelivery: pending('automation-delivery'),
    };
    const oldRows = parseFrozen(
      JSON.stringify({
        version: 1,
        watchers: [automation, legacyRow('other')],
      }),
    );
    expect(oldRows[0]).toEqual(automation);
    oldRows.push(legacyRow('new-old-row'));
    await new FrozenPrePhaseStore(legacyPath).writeFile({
      version: 1,
      updatedAt: STAMP,
      watchers: oldRows,
    });
    expect(parseFrozen(await readFile(legacyPath, 'utf8'))[0]).toEqual(
      automation,
    );
  });

  test('absent sidecar reads empty without creating a file', async () => {
    expect(await readCanonicalWatcherStore(canonicalPath)).toEqual([]);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  test('keeps unknown rows and envelope fields over a read-modify-write', async () => {
    const future = { version: 42, opaque: [1, null, { keep: 'value' }] };
    await writeFile(
      canonicalPath,
      JSON.stringify({
        version: 1,
        updatedAt: STAMP,
        watchers: [future],
        futureEnvelope: { keep: true },
      }),
    );
    const rows = await readCanonicalWatcherStore(canonicalPath);
    await writeCanonicalWatcherStore(canonicalPath, [...rows, { next: true }]);
    const stored: unknown = JSON.parse(await readFile(canonicalPath, 'utf8'));
    expect(stored).toMatchObject({
      version: 1,
      watchers: [future, { next: true }],
      futureEnvelope: { keep: true },
    });
  });
  test.each([
    '{bad json',
    JSON.stringify({ version: 2, watchers: [] }),
    JSON.stringify({ version: 1, watchers: {} }),
  ])(
    'refuses to read or overwrite corrupt/unsupported store %s',
    async (raw) => {
      await writeFile(canonicalPath, raw);
      await expect(readCanonicalWatcherStore(canonicalPath)).rejects.toThrow();
      await expect(
        writeCanonicalWatcherStore(canonicalPath, []),
      ).rejects.toThrow();
      expect(await readFile(canonicalPath, 'utf8')).toBe(raw);
      expect(await fs.readdir(directory)).toEqual([
        'app-advisor-watchers-canonical.json',
      ]);
    },
  );
  test('creates missing parents and publishes private JSON through a temp sibling', async () => {
    const nested = join(directory, 'nested', 'sidecar.json');
    await writeCanonicalWatcherStore(nested, [{ opaque: true }]);
    expect(await readCanonicalWatcherStore(nested)).toEqual([{ opaque: true }]);
    if (process.platform !== 'win32')
      expect((await fs.stat(nested)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dirname(nested))).toEqual(['sidecar.json']);
  });
  test('syncs and closes the temp file before rename, then syncs the directory', async () => {
    const events: string[] = [];
    const realOpen = fs.open;
    const realRename = fs.rename;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        const kind = args[1] === 'wx' ? 'file' : 'directory';
        events.push(`${kind}-open`);
        if (kind === 'file') {
          expect(dirname(String(args[0]))).toBe(directory);
          expect(String(args[0])).not.toBe(canonicalPath);
          expect(args[2]).toBe(0o600);
        }
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'sync').mockImplementation(async () => {
          events.push(`${kind}-sync`);
          await sync();
        });
        jest.spyOn(handle, 'close').mockImplementation(async () => {
          events.push(`${kind}-close`);
          await close();
        });
        return handle;
      });
    jest
      .spyOn(fs, 'rename')
      .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
        events.push('rename');
        await realRename(...args);
      });
    await writeCanonicalWatcherStore(canonicalPath, [{ id: 'row' }]);
    expect(events).toEqual([
      'file-open',
      'file-sync',
      'file-close',
      'rename',
      // CAN-5151 D1: Windows flushes the folder too.
      'directory-open',
      'directory-sync',
      'directory-close',
    ]);
  });

  test.each(['write', 'file-sync', 'file-close', 'rename'])(
    'a failed %s leaves the old store intact and removes the temp file',
    async (failure) => {
      const previous = JSON.stringify({
        version: 1,
        updatedAt: STAMP,
        watchers: [{ id: 'previous' }],
      });
      await writeFile(canonicalPath, previous);
      const realOpen = fs.open;
      jest
        .spyOn(fs, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await realOpen(...args);
          if (args[1] === 'wx') {
            if (failure === 'file-close') {
              const close = handle.close.bind(handle);
              jest.spyOn(handle, 'close').mockImplementation(async () => {
                await close();
                throw new Error('injected file-close failure');
              });
            }
            if (failure === 'write')
              jest
                .spyOn(handle, 'writeFile')
                .mockRejectedValue(new Error('injected write failure'));
            if (failure === 'file-sync')
              jest
                .spyOn(handle, 'sync')
                .mockRejectedValue(new Error('injected file-sync failure'));
          }
          return handle;
        });
      if (failure === 'rename')
        jest
          .spyOn(fs, 'rename')
          .mockRejectedValue(new Error('injected rename failure'));
      await expect(
        writeCanonicalWatcherStore(canonicalPath, [{ id: 'replacement' }]),
      ).rejects.toThrow(`injected ${failure} failure`);
      expect(await readFile(canonicalPath, 'utf8')).toBe(previous);
      expect(await fs.readdir(directory)).toEqual([
        'app-advisor-watchers-canonical.json',
      ]);
    },
  );

  test('directory sync failure rejects acknowledgement even though rename has committed', async () => {
    const realOpen = fs.open;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        // The folder flush opens the directory itself, on every platform.
        if (args[0] === directory)
          jest
            .spyOn(handle, 'sync')
            .mockRejectedValue(new Error('injected directory-sync failure'));
        return handle;
      });
    await expect(
      writeCanonicalWatcherStore(canonicalPath, [{ id: 'committed' }]),
    ).rejects.toThrow('injected directory-sync failure');
    expect(await readCanonicalWatcherStore(canonicalPath)).toEqual([
      { id: 'committed' },
    ]);
    expect(await fs.readdir(directory)).toEqual([
      'app-advisor-watchers-canonical.json',
    ]);
  });

  test('does not treat access errors as a missing file or overwrite the store', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'readFile').mockRejectedValue(error);
    await expect(readCanonicalWatcherStore(canonicalPath)).rejects.toBe(error);
    await expect(writeCanonicalWatcherStore(canonicalPath, [])).rejects.toBe(
      error,
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
