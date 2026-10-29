import type {
  GitHubWorkflowDefinitionSource,
  GitHubWorkflowJobConclusion,
  GitHubWorkflowJobSnapshot,
  GitHubWorkflowRunSnapshot,
  GitHubWorkflowRunState,
} from '@canopy/desktop-shared/types';
import {
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
} from '@canopy/desktop-shared/types';
import {
  normalizeGitHubRepositoryReference,
  parseGitHubWorkflowRunReference,
} from '@canopy/desktop-shared/lib/github-workflow-run-references';
import { MAX_GITHUB_WORKFLOW_GRAPH_NAME_LENGTH } from '@canopy/desktop-shared/lib/github-workflow-definition-graph';
import {
  getGitHubBroker,
  GitHubBrokerError,
  type GitHubRawResponse,
} from './index';

export interface GitHubWorkflowRunFetchResult {
  snapshot: GitHubWorkflowRunSnapshot;
  changed: boolean;
  pollIntervalMs?: number;
}

export interface GitHubWorkflowRunJobResolution {
  repository: string;
  runId: string;
  runAttempt: number;
}

export interface GitHubWorkflowRunJobsFetchResult {
  jobs: GitHubWorkflowJobSnapshot[];
  changed: boolean;
  pollIntervalMs?: number;
}

interface GitHubWorkflowJobPage {
  totalCount: number;
  jobs: GitHubWorkflowJobSnapshot[];
}

interface RawWorkflowRun {
  status?: unknown;
  conclusion?: unknown;
  run_attempt?: unknown;
  html_url?: unknown;
  name?: unknown;
  run_number?: unknown;
  run_started_at?: unknown;
  path?: unknown;
  head_sha?: unknown;
  referenced_workflows?: unknown;
}

const MAX_WORKFLOW_PATH_LENGTH = 512;
const MAX_REFERENCED_WORKFLOWS = 20;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

function workflowFilePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WORKFLOW_PATH_LENGTH ||
    value.startsWith('/') ||
    value.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    return undefined;
  }
  return value;
}

function rootWorkflowFilePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const yamlSeparator = value.lastIndexOf('.yaml@');
  const ymlSeparator = value.lastIndexOf('.yml@');
  const separator = Math.max(yamlSeparator, ymlSeparator);
  const path =
    separator < 0
      ? value
      : value.slice(0, separator + (separator === yamlSeparator ? 5 : 4));
  return workflowFilePath(path);
}

/**
 * Where the run's workflow definition lives. Built only from GitHub's own
 * `path`, `head_sha`, and `referenced_workflows` (`owner/repo/path@sha`);
 * anything malformed drops the whole source so the definition graph is simply
 * unavailable rather than read from a guessed location.
 */
function definitionSourceFromRun(
  run: RawWorkflowRun,
): GitHubWorkflowDefinitionSource | undefined {
  const path = rootWorkflowFilePath(run.path);
  const sha = typeof run.head_sha === 'string' ? run.head_sha : '';
  if (!path || !COMMIT_SHA_PATTERN.test(sha)) return undefined;
  const referenced: GitHubWorkflowDefinitionSource['referenced'] = [];
  const rawReferenced = Array.isArray(run.referenced_workflows)
    ? run.referenced_workflows.slice(0, MAX_REFERENCED_WORKFLOWS)
    : [];
  for (const entry of rawReferenced) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue;
    const at = entry.path.lastIndexOf('@');
    const locator = at > 0 ? entry.path.slice(0, at) : entry.path;
    const [owner, repositoryName, ...rest] = locator.split('/');
    const filePath = workflowFilePath(rest.join('/'));
    const referencedSha =
      typeof entry.sha === 'string' && COMMIT_SHA_PATTERN.test(entry.sha)
        ? entry.sha
        : undefined;
    const repository = normalizeGitHubRepositoryReference(
      `${owner ?? ''}/${repositoryName ?? ''}`,
    );
    if (!repository || !filePath || !referencedSha) continue;
    referenced.push({ repository, path: filePath, sha: referencedSha });
  }
  return { path, sha, referenced };
}

/** GitHub timestamps are ISO 8601; anything else is dropped, never guessed. */
function optionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

type IntermediateStatus = Extract<
  GitHubWorkflowRunState,
  { kind: 'intermediate' }
>['status'];
type TerminalConclusion = Extract<
  GitHubWorkflowRunState,
  { kind: 'terminal' }
>['conclusion'];

const KNOWN_STATUSES = new Set<string>(
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
);
const KNOWN_CONCLUSIONS = new Set<string>(GITHUB_WORKFLOW_RUN_CONCLUSIONS);
const MAX_WORKFLOW_NAME_LENGTH = 120;
const MAX_UNSUPPORTED_VALUE_LENGTH = 64;
const MAX_WORKFLOW_URL_LENGTH = 512;
const MAX_JOB_STATUS_LENGTH = 64;
const JOBS_PER_PAGE = 100;
export const MAX_WATCHED_WORKFLOW_JOBS = 500;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCachedWorkflowRunSnapshot(
  value: unknown,
): value is GitHubWorkflowRunSnapshot {
  return (
    isRecord(value) &&
    isRecord(value.state) &&
    typeof value.runAttempt === 'number' &&
    typeof value.htmlUrl === 'string' &&
    typeof value.observedAt === 'string'
  );
}

function isCachedWorkflowJobSnapshot(
  value: unknown,
): value is GitHubWorkflowJobSnapshot {
  return (
    isRecord(value) &&
    typeof value.jobId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    (value.conclusion === null ||
      (typeof value.conclusion === 'string' &&
        isGitHubWorkflowJobConclusion(value.conclusion))) &&
    typeof value.htmlUrl === 'string' &&
    typeof value.observedAt === 'string'
  );
}

function isCachedWorkflowJobPage(
  value: unknown,
): value is GitHubWorkflowJobPage {
  return (
    isRecord(value) &&
    typeof value.totalCount === 'number' &&
    Array.isArray(value.jobs) &&
    value.jobs.every(isCachedWorkflowJobSnapshot)
  );
}

function isGitHubWorkflowJobConclusion(
  value: string,
): value is GitHubWorkflowJobConclusion {
  return GITHUB_WORKFLOW_JOB_CONCLUSIONS.some(
    (conclusion) => conclusion === value,
  );
}

function isKnownStatus(value: string): value is IntermediateStatus {
  return GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES.some(
    (status) => status === value,
  );
}

function isKnownConclusion(value: string): value is TerminalConclusion {
  return GITHUB_WORKFLOW_RUN_CONCLUSIONS.some(
    (conclusion) => conclusion === value,
  );
}

function optionalBoundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_WORKFLOW_NAME_LENGTH) : undefined;
}

function optionalStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_UNSUPPORTED_VALUE_LENGTH) : null;
}

function positiveDecimalString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  try {
    return BigInt(value).toString();
  } catch {
    return null;
  }
}

function boundedJobName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .split('')
    .map((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized
    ? normalized.slice(0, MAX_GITHUB_WORKFLOW_GRAPH_NAME_LENGTH)
    : null;
}

function githubHtmlUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_WORKFLOW_URL_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      ['github.com', 'www.github.com'].includes(
        parsed.hostname.toLowerCase(),
      ) &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.port.length === 0
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function normalizeGitHubWorkflowJob(
  value: unknown,
  observedAt: string,
): GitHubWorkflowJobSnapshot {
  if (!isRecord(value)) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow jobs response was malformed.',
    );
  }
  const jobId = positiveDecimalString(value.id);
  const name = boundedJobName(value.name);
  const htmlUrl = githubHtmlUrl(value.html_url);
  const status = optionalStringOrNull(value.status);
  const rawConclusion = optionalStringOrNull(value.conclusion);
  const conclusion =
    rawConclusion && isGitHubWorkflowJobConclusion(rawConclusion)
      ? rawConclusion
      : null;
  if (!jobId || !name || !htmlUrl || !status) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow jobs response was malformed.',
    );
  }
  const createdAt = optionalIsoTimestamp(value.created_at);
  const startedAt = optionalIsoTimestamp(value.started_at);
  const completedAt = optionalIsoTimestamp(value.completed_at);
  return {
    jobId,
    name,
    status: status.slice(0, MAX_JOB_STATUS_LENGTH),
    conclusion,
    htmlUrl,
    ...(createdAt ? { createdAt } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    observedAt,
  };
}

function normalizeGitHubWorkflowJobPage(
  value: unknown,
  observedAt: string,
): GitHubWorkflowJobPage {
  if (
    !isRecord(value) ||
    typeof value.total_count !== 'number' ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    !Array.isArray(value.jobs)
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow jobs response was malformed.',
    );
  }
  if (value.total_count > MAX_WATCHED_WORKFLOW_JOBS) {
    throw new GitHubBrokerError(
      'invalid_response',
      `Workflow run has more than ${MAX_WATCHED_WORKFLOW_JOBS} jobs.`,
    );
  }
  return {
    totalCount: value.total_count,
    jobs: value.jobs.map((job) => normalizeGitHubWorkflowJob(job, observedAt)),
  };
}

export function normalizeGitHubWorkflowRunState(
  statusValue: unknown,
  conclusionValue: unknown,
): GitHubWorkflowRunState {
  const status = optionalStringOrNull(statusValue);
  const conclusion = optionalStringOrNull(conclusionValue);
  if (status && KNOWN_STATUSES.has(status) && isKnownStatus(status)) {
    return {
      kind: 'intermediate',
      status,
    };
  }
  if (status === 'completed') {
    if (
      conclusion &&
      KNOWN_CONCLUSIONS.has(conclusion) &&
      isKnownConclusion(conclusion)
    ) {
      return {
        kind: 'terminal',
        conclusion,
      };
    }
    return { kind: 'unsupported', status, conclusion, terminal: true };
  }
  return { kind: 'unsupported', status, conclusion, terminal: false };
}

export function normalizeGitHubWorkflowRun(
  value: unknown,
  observedAt = new Date().toISOString(),
): GitHubWorkflowRunSnapshot {
  if (!isRecord(value)) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow run response was malformed.',
    );
  }
  const run: RawWorkflowRun = {
    status: value.status,
    conclusion: value.conclusion,
    run_attempt: value.run_attempt,
    html_url: value.html_url,
    name: value.name,
    run_number: value.run_number,
    run_started_at: value.run_started_at,
    path: value.path,
    head_sha: value.head_sha,
    referenced_workflows: value.referenced_workflows,
  };
  const definitionSource = definitionSourceFromRun(run);
  const runAttempt = run.run_attempt;
  const htmlUrl = run.html_url;
  let parsedHtmlUrl: URL | null = null;
  if (
    typeof htmlUrl === 'string' &&
    htmlUrl.length <= MAX_WORKFLOW_URL_LENGTH
  ) {
    try {
      parsedHtmlUrl = new URL(htmlUrl);
    } catch {
      parsedHtmlUrl = null;
    }
  }
  if (
    typeof runAttempt !== 'number' ||
    !Number.isInteger(runAttempt) ||
    runAttempt <= 0 ||
    !parsedHtmlUrl ||
    parsedHtmlUrl.protocol !== 'https:' ||
    !['github.com', 'www.github.com'].includes(
      parsedHtmlUrl.hostname.toLowerCase(),
    ) ||
    parsedHtmlUrl.username.length > 0 ||
    parsedHtmlUrl.password.length > 0 ||
    parsedHtmlUrl.port.length > 0
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow run response was malformed.',
    );
  }
  const runNumber = run.run_number;
  if (
    runNumber !== undefined &&
    (typeof runNumber !== 'number' ||
      !Number.isInteger(runNumber) ||
      runNumber <= 0)
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow run response was malformed.',
    );
  }
  return {
    state: normalizeGitHubWorkflowRunState(run.status, run.conclusion),
    runAttempt,
    htmlUrl: parsedHtmlUrl.toString(),
    ...(optionalBoundedString(run.name)
      ? { workflowName: optionalBoundedString(run.name) }
      : {}),
    ...(typeof runNumber === 'number' ? { runNumber } : {}),
    ...(optionalIsoTimestamp(run.run_started_at)
      ? { startedAt: optionalIsoTimestamp(run.run_started_at) }
      : {}),
    ...(definitionSource ? { definitionSource } : {}),
    observedAt,
  };
}

export async function fetchGitHubWorkflowRun(options: {
  repository: string;
  runId: string;
  requestedAttempt?: number;
  priority: 'interactive' | 'watcher';
  signal?: AbortSignal;
  /** Spend-summary label for the broker. */
  caller?: string;
  timeoutMs?: number;
}): Promise<GitHubWorkflowRunFetchResult> {
  const [owner, repository] = options.repository.split('/');
  if (!owner || !repository || !/^[1-9]\d*$/.test(options.runId)) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow run request was malformed.',
    );
  }
  const result = await getGitHubBroker().execute<GitHubWorkflowRunSnapshot>(
    async (
      octokit,
      conditionalHeaders,
    ): Promise<GitHubRawResponse<GitHubWorkflowRunSnapshot>> => {
      // Keep the identifier as a string so values beyond Number.MAX_SAFE_INTEGER
      // reach GitHub without precision loss. Widening the route avoids Octokit's
      // generated `number` type for this path parameter; its runtime supports
      // string route substitutions.
      const workflowRunRoute: string = options.requestedAttempt
        ? 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}'
        : 'GET /repos/{owner}/{repo}/actions/runs/{run_id}';
      const response = await octokit.request(workflowRunRoute, {
        owner,
        repo: repository,
        run_id: options.runId,
        ...(options.requestedAttempt
          ? { attempt_number: options.requestedAttempt }
          : {}),
        headers: conditionalHeaders,
      });
      const snapshot = normalizeGitHubWorkflowRun(response.data);
      if (
        options.requestedAttempt !== undefined &&
        snapshot.runAttempt !== options.requestedAttempt
      ) {
        throw new GitHubBrokerError(
          'invalid_response',
          'GitHub returned a different workflow run attempt than requested.',
        );
      }
      return {
        status: response.status,
        headers: response.headers,
        data: snapshot,
      };
    },
    {
      priority: options.priority,
      ...(options.caller ? { caller: options.caller } : {}),
      operation: 'read',
      idempotency: 'safe',
      resourceKey: `workflow-run:${options.repository}/${options.runId}/${options.requestedAttempt ?? 'current'}`,
      conditional: true,
      isCachedData: isCachedWorkflowRunSnapshot,
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow run read returned a mutation result.',
    );
  }
  return {
    snapshot: result.data,
    changed: result.changed,
    ...(result.pollIntervalMs !== undefined
      ? { pollIntervalMs: result.pollIntervalMs }
      : {}),
  };
}

/**
 * Fetch the bounded job projection for one exact workflow-run attempt.
 * Pages use independent conditional-cache keys and are coalesced by the
 * shared broker; raw job steps and runner metadata never leave this module.
 */
export async function fetchGitHubWorkflowRunJobs(options: {
  repository: string;
  runId: string;
  runAttempt: number;
  priority: 'interactive' | 'watcher';
  signal?: AbortSignal;
  /** Spend-summary label for the broker. */
  caller?: string;
  timeoutMs?: number;
}): Promise<GitHubWorkflowRunJobsFetchResult> {
  const [owner, repository] = options.repository.split('/');
  if (
    !owner ||
    !repository ||
    !/^[1-9]\d*$/.test(options.runId) ||
    !Number.isSafeInteger(options.runAttempt) ||
    options.runAttempt <= 0
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow jobs request was malformed.',
    );
  }

  const observedAt = new Date().toISOString();
  const jobs: GitHubWorkflowJobSnapshot[] = [];
  let page = 1;
  let totalCount = 0;
  let changed = false;
  let pollIntervalMs: number | undefined;
  do {
    const pageNumber = page;
    const result = await getGitHubBroker().execute<GitHubWorkflowJobPage>(
      async (
        octokit,
        conditionalHeaders,
      ): Promise<GitHubRawResponse<GitHubWorkflowJobPage>> => {
        const route: string =
          'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs';
        const response = await octokit.request(route, {
          owner,
          repo: repository,
          run_id: options.runId,
          attempt_number: options.runAttempt,
          per_page: JOBS_PER_PAGE,
          page: pageNumber,
          headers: conditionalHeaders,
        });
        return {
          status: response.status,
          headers: response.headers,
          data: normalizeGitHubWorkflowJobPage(response.data, observedAt),
        };
      },
      {
        priority: options.priority,
        ...(options.caller ? { caller: options.caller } : {}),
        operation: 'read',
        idempotency: 'safe',
        resourceKey: `workflow-run-jobs:${options.repository}/${options.runId}/${options.runAttempt}/${pageNumber}`,
        conditional: true,
        isCachedData: isCachedWorkflowJobPage,
        timeoutMs: options.timeoutMs ?? 20_000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (result.kind !== 'read') {
      throw new GitHubBrokerError(
        'invalid_response',
        'GitHub workflow jobs read returned a mutation result.',
      );
    }
    totalCount = result.data.totalCount;
    jobs.push(...result.data.jobs);
    changed ||= result.changed;
    if (result.pollIntervalMs !== undefined) {
      pollIntervalMs = Math.max(pollIntervalMs ?? 0, result.pollIntervalMs);
    }
    page += 1;
  } while (jobs.length < totalCount);

  const uniqueJobs = new Map<string, GitHubWorkflowJobSnapshot>();
  for (const job of jobs) uniqueJobs.set(job.jobId, job);
  if (uniqueJobs.size !== totalCount) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow jobs response was incomplete.',
    );
  }
  return {
    jobs: Array.from(uniqueJobs.values()).sort((left, right) =>
      BigInt(left.jobId) < BigInt(right.jobId)
        ? -1
        : BigInt(left.jobId) > BigInt(right.jobId)
          ? 1
          : 0,
    ),
    changed,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  };
}

/** Resolve a GitHub Actions job to its containing workflow run during setup. */
export async function resolveGitHubWorkflowRunJob(options: {
  repository: string;
  jobId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<GitHubWorkflowRunJobResolution> {
  const canonicalRepository = normalizeGitHubRepositoryReference(
    options.repository,
  );
  const [owner, repository] = canonicalRepository?.split('/') ?? [];
  if (!owner || !repository || !/^[1-9]\d*$/.test(options.jobId)) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow job request was malformed.',
    );
  }
  const result =
    await getGitHubBroker().execute<GitHubWorkflowRunJobResolution>(
      async (
        octokit,
      ): Promise<GitHubRawResponse<GitHubWorkflowRunJobResolution>> => {
        const route: string = 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}';
        const response = await octokit.request(route, {
          owner,
          repo: repository,
          job_id: options.jobId,
        });
        if (!isRecord(response.data)) {
          throw new GitHubBrokerError(
            'invalid_response',
            'GitHub workflow job response was malformed.',
          );
        }
        const data = response.data;
        const parsed =
          typeof data.run_url === 'string'
            ? parseGitHubWorkflowRunReference(data.run_url)
            : null;
        const responseRunId =
          typeof data.run_id === 'number' &&
          Number.isSafeInteger(data.run_id) &&
          data.run_id > 0
            ? String(data.run_id)
            : typeof data.run_id === 'string' && /^[1-9]\d*$/.test(data.run_id)
              ? BigInt(data.run_id).toString()
              : undefined;
        const runAttempt =
          typeof data.run_attempt === 'number' &&
          Number.isSafeInteger(data.run_attempt) &&
          data.run_attempt > 0
            ? data.run_attempt
            : undefined;
        if (
          !parsed?.ok ||
          !parsed.value.repository ||
          !parsed.value.runId ||
          parsed.value.repository !== canonicalRepository ||
          (responseRunId !== undefined &&
            responseRunId !== parsed.value.runId) ||
          runAttempt === undefined
        ) {
          throw new GitHubBrokerError(
            'invalid_response',
            'GitHub workflow job response was malformed.',
          );
        }
        return {
          status: response.status,
          headers: response.headers,
          data: {
            repository: parsed.value.repository,
            runId: parsed.value.runId,
            runAttempt,
          },
        };
      },
      {
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
        timeoutMs: options.timeoutMs ?? 20_000,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow job read returned a mutation result.',
    );
  }
  return result.data;
}
