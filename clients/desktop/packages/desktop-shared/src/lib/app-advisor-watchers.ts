// Subpath import keeps the agent action tool engine out of renderer bundles.
import {
  buildAgentWatcherCatalog,
  rankAgentWatcherHookTriggers,
  searchAgentWatcherCatalog,
  type AgentWatcherCatalogEntry,
} from '@canopy/agent-actions/watchers/catalog';
import type { CanonicalChatWatcherSetupResult } from './chat-watcher-contracts';
import type {
  AppAdvisorWatcherSummary,
  AppAdvisorWatcherTarget,
  AppAdvisorWatcherTriggerType,
  HookWatcherTriggerCatalogEntry,
  SearchAppAdvisorWatchersInput,
  SearchAppAdvisorWatchersResult,
  SetupAppAdvisorWatchersResult,
  WatcherSearchTarget,
  WatchGitHubItemsInput,
  WatchGitHubItemsResult,
} from '../types';
import type { PrMergeQueueKnownPhase } from '../types/github';
import type {
  GitHubPullRequestNotificationSelection,
  GitHubPullRequestTarget,
  GitHubPullRequestWatcherEventKind,
  GitHubWorkflowRunInput,
} from '../types/github-watchers';
import {
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
} from '../types';
import {
  createHookKey,
  getHookTriggerDisplayName,
  SUPPORTED_HOOK_TRIGGERS,
} from '../hooks';
import {
  isGitHubPullRequestUrl,
  normalizeGitHubPullRequestNumber,
} from '@canopy/protocol/portable-tasks/pull-request-reference';
import {
  MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS,
  normalizeGitHubPullRequestTargets,
} from './github-pull-request-references';
import { normalizeGitHubRepositoryReference } from './github-workflow-run-references';
import {
  isPrMergeQueueKnownPhase,
  PR_MERGE_QUEUE_KNOWN_PHASES,
} from './pr-merge-queue';

/**
 * The App Advisor watcher catalog (the trigger types the `setup_watchers` /
 * `search_watchers` provider tools expose), built from the shared catalog in
 * `@canopy/agent-actions` with this app's hook triggers, so the backend tool
 * runtime and the renderer's watcher UI describe watchers from the same data.
 */
export type AppAdvisorWatcherCatalogEntry =
  AgentWatcherCatalogEntry<HookWatcherTriggerCatalogEntry>;

const HOOK_TRIGGER_KEYWORDS: Partial<Record<string, readonly string[]>> = {
  'worktree:precommit:failure': [
    'precommit',
    'pre-commit',
    'commit',
    'failure',
  ],
  'pr:create': ['pull request', 'opened', 'created', 'new'],
  'pr:reviews:new': ['review', 'reviewed', 'submitted', 'new'],
  'pr:reviews:new:has-comments': [
    'review',
    'reviews',
    'comment',
    'comments',
    'inline',
    'feedback',
  ],
  'pr:update:comments': [
    'comment',
    'comments',
    'discussion',
    'conversation',
    'updated',
    'new',
  ],
  'pr:update:labels': ['label', 'labels', 'tag', 'tags'],
  'pr:checks:fail': ['check', 'checks', 'ci', 'failed', 'failure'],
  'pr:checks:pass': ['check', 'checks', 'ci', 'passed', 'success'],
  'pr:checks:pass:all': ['check', 'checks', 'ci', 'passed', 'success', 'all'],
  'pr:checks:finished': ['check', 'checks', 'ci', 'finished', 'complete'],
  'pr:checks:finished:has-fail': [
    'check',
    'checks',
    'ci',
    'finished',
    'failed',
    'failure',
  ],
  'pr:merge-conflicts': ['merge', 'conflict', 'conflicts'],
  'pr:queue:removed': [
    'pull request',
    'merge queue',
    'removed',
    'removal',
    'dequeued',
    'kicked',
    'ejected',
    'failed',
  ],
  'pr:queue:entered': [
    'pull request',
    'merge queue',
    'entered',
    'enqueued',
    'queued',
    'added',
  ],
  'pr:merged': ['merge', 'merged'],
  'pr:closed': ['closed', 'close'],
};

export const HOOK_TRIGGER_CATALOG: readonly HookWatcherTriggerCatalogEntry[] =
  SUPPORTED_HOOK_TRIGGERS.map((triggerName) => {
    const title = getHookTriggerDisplayName(triggerName);
    return {
      triggerName,
      title,
      hookKeyExamples: {
        project: createHookKey('project', triggerName),
        workspaceRoot: createHookKey('workspace-root', triggerName),
        workspaceRepoPattern: `workspace-repo:<repoId>:${triggerName}`,
      },
      setupTarget: { triggerName },
      keywords: [
        triggerName,
        title,
        ...(HOOK_TRIGGER_KEYWORDS[triggerName] ?? []),
      ],
    };
  });

/**
 * Legacy chat triggers stay accepted on input for compatibility, but agents
 * are steered to the canonical project/bot triggers, so search hides them.
 */
const LEGACY_CHAT_WATCHER_TRIGGERS: ReadonlySet<AppAdvisorWatcherTriggerType> =
  new Set<AppAdvisorWatcherTriggerType>([
    'worktree_chat_completion',
    'standalone_chat_completion',
    'worktree_new_chat_started',
    'standalone_new_chat_started',
  ]);

const WATCHER_CATALOG: readonly AppAdvisorWatcherCatalogEntry[] =
  buildAgentWatcherCatalog({
    hookTriggers: HOOK_TRIGGER_CATALOG,
    hookTriggerNames: SUPPORTED_HOOK_TRIGGERS,
    pullRequestQueuePhases: PR_MERGE_QUEUE_KNOWN_PHASES,
  });

export const APP_ADVISOR_WATCHER_CATALOG: readonly AppAdvisorWatcherCatalogEntry[] =
  WATCHER_CATALOG.map((entry) =>
    LEGACY_CHAT_WATCHER_TRIGGERS.has(entry.trigger)
      ? { ...entry, hidden: true }
      : entry,
  );

/**
 * Catalog + active-watcher search for the App Advisor `search_watchers`
 * provider tool. Mirrors the lightweight scoring approach used by
 * {@link import('./app-advisor-actions').searchAppAdvisorActions}: tokens
 * are matched case-insensitively against the catalog entry's title,
 * usageGuidance, trigger key, and keywords.
 *
 * Semantics (must match backend and frontend expectations):
 *  - `query` performs case-insensitive contains scoring across `title`,
 *    `usageGuidance`, the trigger key, and the entry's keywords.
 *  - Hidden compatibility rows are never advertised, even by exact trigger.
 *  - `options.includeLegacyChatTriggers: true` keeps the legacy chat rows
 *    visible, for surfaces that do not offer the canonical triggers yet.
 *  - `options.botsEnabled: false` removes bot rows before scoring/limiting;
 *    omitted/true preserves the unrestricted Advisor catalog. This is a
 *    projection option, not an authorization decision.
 *  - `trigger` filters the visible catalog to that trigger only.
 *  - `limit` clamps the catalog row count; defaults to `DEFAULT_CATALOG_LIMIT`.
 *  - `includeActive`:
 *      - `false` → return `activeWatchers: []` (catalog-only).
 *      - `undefined` or `true` → return the caller-supplied `activeWatchers`
 *        verbatim. The caller is responsible for handing in a list that has
 *        already been filtered to the visible status set (`active` and
 *        `delivery_failed`).
 */
export function searchAppAdvisorWatchers(
  input: SearchAppAdvisorWatchersInput = {},
  activeWatchers: AppAdvisorWatcherSummary[] = [],
  options: {
    botsEnabled?: boolean;
    includeLegacyChatTriggers?: boolean;
    /** Cowork project pipelines have no task identity. */
    isCoworkProject?: (projectId: string) => boolean;
  } = {},
): SearchAppAdvisorWatchersResult {
  const includeActive = input.includeActive !== false;
  const catalog = options.includeLegacyChatTriggers
    ? WATCHER_CATALOG
    : APP_ADVISOR_WATCHER_CATALOG;
  return {
    // Root policy may hide bot rows before scoring and limiting; this is a
    // projection option, not an authorization decision.
    catalog: searchAgentWatcherCatalog(
      options.botsEnabled === false
        ? catalog.filter(
            (entry) =>
              entry.trigger !== 'bot_task_chat_completion' &&
              entry.trigger !== 'bot_new_chat_started',
          )
        : catalog,
      input,
    ),
    activeWatchers: includeActive
      ? activeWatchers.map((watcher) =>
          projectActiveWatcherForProvider(watcher, options.isCoworkProject),
        )
      : [],
  };
}

/** Pipeline and hook watcher identity for SearchWatchers instance rows. */
export function watcherSearchTarget(
  target: AppAdvisorWatcherTarget,
  isCoworkProject: (projectId: string) => boolean = () => false,
): WatcherSearchTarget | undefined {
  if (target.kind === 'worktree_pipeline')
    return {
      projectId: target.projectId,
      ...(isCoworkProject(target.projectId)
        ? {}
        : { taskId: target.worktreeId }),
      ...(target.executionId ? { executionId: target.executionId } : {}),
      ...(target.pipelineId ? { pipelineId: target.pipelineId } : {}),
    };
  if (target.kind === 'worktree_hook')
    return {
      projectId: target.projectId,
      taskId: target.worktreeId,
      triggerName: target.triggerName,
      ...(target.hookKey ? { hookKey: target.hookKey } : {}),
    };
  return undefined;
}

export const DEFAULT_ACTIVE_WATCHER_PAGE_SIZE = 50;
export const MAX_ACTIVE_WATCHER_PAGE_SIZE = 200;
export const MAX_ACTIVE_WATCHER_QUERY_LENGTH = 500;

type PageableWatcherRow = { id: string; label?: string; target?: object };

const TARGET_FILTER_KEYS = [
  ['targetProjectId', 'projectId'],
  ['targetBotId', 'botId'],
  ['targetTaskId', 'taskId'],
  ['targetChatId', 'chatId'],
] as const;

function targetId(
  target: object | undefined,
  key: 'projectId' | 'botId' | 'taskId' | 'chatId',
): string | undefined {
  if (!target || !(key in target)) return undefined;
  const value: unknown = Reflect.get(target, key);
  return typeof value === 'string' ? value : undefined;
}

/** Deterministic, non-cryptographic fingerprint binding a cursor to its filters. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Filters and pages already-authorized SearchWatchers instance rows,
 * independently of catalog search. Rows without a target never match a target
 * filter. A cursor is valid only for the filters and query that produced it.
 */
export function pageActiveWatchers<T extends PageableWatcherRow>(
  rows: readonly T[],
  input: SearchAppAdvisorWatchersInput,
):
  | {
      ok: true;
      activeWatchers: T[];
      activeReturned: number;
      activeTotalMatches: number;
      activeNextCursor?: string;
    }
  | { ok: false; error: string } {
  if (input.targetProjectId !== undefined && input.targetBotId !== undefined)
    return {
      ok: false,
      error: 'targetProjectId and targetBotId cannot be combined.',
    };
  const query = (input.activeQuery ?? '').trim().toLowerCase();
  if (query.length > MAX_ACTIVE_WATCHER_QUERY_LENGTH)
    return { ok: false, error: 'activeQuery is too long.' };
  const pageSize = Math.min(
    MAX_ACTIVE_WATCHER_PAGE_SIZE,
    Math.max(
      1,
      Math.floor(input.activePageSize ?? DEFAULT_ACTIVE_WATCHER_PAGE_SIZE),
    ),
  );
  const matches = rows.filter((row) => {
    for (const [filter, key] of TARGET_FILTER_KEYS) {
      const wanted = input[filter];
      if (wanted !== undefined && targetId(row.target, key) !== wanted)
        return false;
    }
    if (!query) return true;
    return [
      row.id,
      row.label,
      ...TARGET_FILTER_KEYS.map(([, key]) => targetId(row.target, key)),
    ].some((value) => value?.toLowerCase().includes(query));
  });
  const key = fingerprint(
    JSON.stringify([
      query,
      ...TARGET_FILTER_KEYS.map(([filter]) => input[filter] ?? null),
    ]),
  );
  let offset = 0;
  if (input.activeCursor !== undefined) {
    const match = /^v1\.(\d{1,9})\.([0-9a-f]{8})$/.exec(input.activeCursor);
    if (!match || match[2] !== key)
      return { ok: false, error: 'Invalid activeCursor.' };
    offset = Number(match[1]);
  }
  const page = matches.slice(offset, offset + pageSize);
  const next = offset + page.length;
  return {
    ok: true,
    activeWatchers: page,
    activeReturned: page.length,
    activeTotalMatches: matches.length,
    ...(next < matches.length ? { activeNextCursor: `v1.${next}.${key}` } : {}),
  };
}

function projectActiveWatcherForProvider(
  watcher: AppAdvisorWatcherSummary,
  isCoworkProject?: (projectId: string) => boolean,
): SearchAppAdvisorWatchersResult['activeWatchers'][number] {
  const availability = watcher.availability
    ? { availability: watcher.availability }
    : {};
  if (watcher.target.kind === 'github_workflow_runs') {
    return {
      ...availability,
      id: watcher.id,
      trigger: watcher.trigger,
      status: watcher.status,
      label: watcher.label,
      targetKind: watcher.target.kind,
      itemCount: watcher.target.items.length,
      repositoryCount: watcher.target.display.repositories.length,
      selectedFilters: {
        statuses: [...watcher.target.notifyOn.statuses],
        conclusions: [...watcher.target.notifyOn.conclusions],
        jobConclusions: [...watcher.target.notifyOn.jobConclusions],
      },
      samples: watcher.target.display.sample.slice(0, 2).map((sample) => ({
        ...sample,
      })),
      ...(watcher.githubRateLimitedUntil
        ? { rateLimitedUntil: watcher.githubRateLimitedUntil }
        : {}),
    };
  }
  if (watcher.target.kind === 'github_pull_requests') {
    return {
      ...availability,
      id: watcher.id,
      trigger: watcher.trigger,
      status: watcher.status,
      label: watcher.label,
      targetKind: watcher.target.kind,
      itemCount: watcher.target.items.length,
      repositoryCount: watcher.target.display.repositories.length,
      ...(watcher.githubRateLimitedUntil
        ? { rateLimitedUntil: watcher.githubRateLimitedUntil }
        : {}),
    };
  }
  const target = watcherSearchTarget(watcher.target, isCoworkProject);
  return {
    ...availability,
    id: watcher.id,
    trigger: watcher.trigger,
    status: watcher.status,
    label: watcher.label,
    targetKind: watcher.target.kind,
    ...(target ? { target } : {}),
  };
}

export type NormalizedWatchGitHubItemsInput = Omit<
  WatchGitHubItemsInput,
  'items' | 'notifyOn'
> & {
  items: Array<{
    kind: 'workflow_run';
    repository: string;
    runId: string;
    requestedAttempt?: number;
  }>;
  notifyOn: {
    statuses: (typeof GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES)[number][];
    conclusions: (typeof GITHUB_WORKFLOW_RUN_CONCLUSIONS)[number][];
    jobConclusions: (typeof GITHUB_WORKFLOW_JOB_CONCLUSIONS)[number][];
  };
};

export type NormalizeWatchGitHubItemsResult =
  | {
      ok: true;
      value: NormalizedWatchGitHubItemsInput;
      sourceIndexByKey: Map<string, number>;
    }
  | Extract<WatchGitHubItemsResult, { ok: false }>;

const WATCH_GITHUB_ITEM_KEYS = [
  'kind',
  'repository',
  'runId',
  'requestedAttempt',
] as const;
const WATCH_GITHUB_REFERENCE_ITEM_KEYS = [
  'kind',
  'target',
  'repository',
  'runAttempt',
] as const;
const WATCH_GITHUB_RUN_ID_ITEM_KEYS = [
  'kind',
  'repository',
  'runId',
  'runAttempt',
] as const;
const WATCH_GITHUB_INPUT_KEYS = [
  'items',
  'repository',
  'notifyOn',
  'label',
  'followUpInstruction',
  'allowDuplicate',
] as const;
const WATCH_GITHUB_NOTIFY_KEYS = [
  'run',
  'jobs',
  'statuses',
  'conclusions',
] as const;
const WATCH_GITHUB_RUN_NOTIFY_KEYS = ['statuses', 'conclusions'] as const;
const WATCH_GITHUB_JOB_NOTIFY_KEYS = ['conclusions'] as const;

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGitHubWorkflowRunReference(
  value: unknown,
): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function isWatchGitHubItemInput(
  value: unknown,
): value is GitHubWorkflowRunInput {
  if (isGitHubWorkflowRunReference(value)) return true;
  const item = recordValue(value);
  if (!item || item.kind !== 'workflow_run') return false;
  if (item.repository !== undefined && typeof item.repository !== 'string') {
    return false;
  }
  if (
    item.runAttempt !== undefined &&
    (typeof item.runAttempt !== 'number' ||
      !Number.isSafeInteger(item.runAttempt) ||
      item.runAttempt <= 0)
  ) {
    return false;
  }
  if ('target' in item) {
    return (
      !('runId' in item) &&
      hasOnlyKeys(item, WATCH_GITHUB_REFERENCE_ITEM_KEYS) &&
      isGitHubWorkflowRunReference(item.target)
    );
  }
  return (
    hasOnlyKeys(item, WATCH_GITHUB_RUN_ID_ITEM_KEYS) &&
    isGitHubWorkflowRunReference(item.runId)
  );
}

function normalizeRepository(value: unknown): string | null {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (
    value.includes('://') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\') ||
    value.includes(':')
  ) {
    return null;
  }
  const segments = value.split('/');
  if (
    segments.length !== 2 ||
    segments[0].includes('.') ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9_.-]+$/.test(segment),
    )
  ) {
    return null;
  }
  return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}

function normalizeRunId(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  try {
    const numeric = BigInt(value);
    return numeric > BigInt(0) ? numeric.toString() : null;
  } catch {
    return null;
  }
}

function normalizeSelection<T extends string>(
  value: unknown,
  known: readonly T[],
): T[] | null {
  if (value === 'any') return [...known];
  if (!Array.isArray(value) || value.length === 0) return null;
  const selected = new Set<T>();
  const isKnown = (item: string): item is T =>
    known.some((knownItem) => knownItem === item);
  for (const item of value) {
    if (typeof item !== 'string' || !isKnown(item) || selected.has(item)) {
      return null;
    }
    selected.add(item);
  }
  return known.filter((item) => selected.has(item));
}

export type NormalizedWatchGitHubItemsRequest = Omit<
  WatchGitHubItemsInput,
  'items' | 'notifyOn'
> & {
  items: GitHubWorkflowRunInput[];
  notifyOn: NormalizedWatchGitHubItemsInput['notifyOn'];
};

export type NormalizeWatchGitHubItemsRequestResult =
  | { ok: true; value: NormalizedWatchGitHubItemsRequest }
  | Extract<WatchGitHubItemsResult, { ok: false }>;

/** Fully validated pull request watcher request, items in request order. */
export interface NormalizedWatchGitHubPullRequestsRequest {
  family: 'pull_request';
  items: GitHubPullRequestTarget[];
  /** Omitted for the default (merge, close, and queue removal only). */
  notifyOn?: GitHubPullRequestNotificationSelection;
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
}

export type NormalizedWatchGitHubItemsFamilyRequest =
  | ({ family: 'workflow_run' } & NormalizedWatchGitHubItemsRequest)
  | NormalizedWatchGitHubPullRequestsRequest;

export type NormalizeWatchGitHubItemsFamilyRequestResult =
  | { ok: true; value: NormalizedWatchGitHubItemsFamilyRequest }
  | Extract<WatchGitHubItemsResult, { ok: false }>;

const MAX_GITHUB_WORKFLOW_RUN_WATCH_ITEMS = 20;
const MIXED_GITHUB_FAMILIES_MESSAGE =
  'Use one target family per watcher: workflow runs or pull requests, not both.';
const PULL_REQUEST_URL_AS_RUN_MESSAGE =
  'This is a pull request URL, not a workflow run. To watch a pull request, pass {"kind":"pull_request","target":"<pull request URL>"}.';
const PULL_REQUEST_NOTIFY_ON_MESSAGE =
  'Pull request watchers always notify on merge, close, and merge queue removal. notifyOn accepts only {"queue":{"entered":true,"phases":[...]}}.';
const PULL_REQUEST_QUEUE_PHASES_MESSAGE = `notifyOn.queue.phases must be "any" or a list of: ${PR_MERGE_QUEUE_KNOWN_PHASES.join(', ')}.`;
const WORKFLOW_RUN_QUEUE_MESSAGE =
  'notifyOn.queue applies only to pull request watchers.';
const WATCH_GITHUB_PULL_REQUEST_NOTIFY_KEYS = ['queue'] as const;
const WATCH_GITHUB_PULL_REQUEST_QUEUE_KEYS = ['entered', 'phases'] as const;

type WatchGitHubItemsEnvelope =
  | {
      ok: true;
      family: 'workflow_run' | 'pull_request';
      value: Record<string, unknown>;
      items: unknown[];
    }
  | Extract<WatchGitHubItemsResult, { ok: false }>;

function readWatchGitHubItemsEnvelope(
  input: unknown,
): WatchGitHubItemsEnvelope {
  const value = recordValue(input);
  if (!value || !hasOnlyKeys(value, WATCH_GITHUB_INPUT_KEYS)) {
    return invalidWatchGitHubItems();
  }
  const items = value.items;
  if (!Array.isArray(items) || items.length === 0) {
    return invalidWatchGitHubItems(undefined, 'items');
  }
  const hasPullRequest = items.some(
    (item) => isRecord(item) && item.kind === 'pull_request',
  );
  const hasWorkflowRun = items.some(
    (item) =>
      isGitHubWorkflowRunReference(item) ||
      (isRecord(item) && item.kind === 'workflow_run'),
  );
  if (hasPullRequest && hasWorkflowRun) {
    return invalidWatchGitHubItems(MIXED_GITHUB_FAMILIES_MESSAGE, 'items');
  }
  return {
    ok: true,
    family: hasPullRequest ? 'pull_request' : 'workflow_run',
    value,
    items,
  };
}

function invalidWatchGitHubItems(
  message = 'Invalid WatchGitHubItems input.',
  field?: 'items' | 'repository' | 'notifyOn',
): Extract<WatchGitHubItemsResult, { ok: false }> {
  return {
    ok: false,
    code: 'invalid_input',
    message,
    ...(field ? { field } : {}),
  };
}

function optionalWatcherFields(
  value: Record<string, unknown>,
): Pick<
  NormalizedWatchGitHubPullRequestsRequest,
  'label' | 'followUpInstruction' | 'allowDuplicate'
> {
  return {
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.followUpInstruction === 'string'
      ? { followUpInstruction: value.followUpInstruction }
      : {}),
    ...(typeof value.allowDuplicate === 'boolean'
      ? { allowDuplicate: value.allowDuplicate }
      : {}),
  };
}

function hasInvalidScalarFields(value: Record<string, unknown>): boolean {
  return (
    (value.repository !== undefined && typeof value.repository !== 'string') ||
    (value.label !== undefined && typeof value.label !== 'string') ||
    (value.followUpInstruction !== undefined &&
      typeof value.followUpInstruction !== 'string') ||
    (value.allowDuplicate !== undefined &&
      typeof value.allowDuplicate !== 'boolean')
  );
}

/**
 * Validate a WatchGitHubItems request and route it to one target family.
 * Pull request items are fully normalized here (no GitHub request needed);
 * workflow-run items keep raw references for the async run resolver.
 */
export function normalizeWatchGitHubItemsFamilyRequest(
  input: unknown,
  options: { repositoryCandidates?: readonly string[] } = {},
): NormalizeWatchGitHubItemsFamilyRequestResult {
  const envelope = readWatchGitHubItemsEnvelope(input);
  if (!envelope.ok) return envelope;
  const { value, items } = envelope;
  if (envelope.family === 'workflow_run') {
    const runs = normalizeWorkflowRunRequest(value, items);
    return runs.ok
      ? { ok: true, value: { family: 'workflow_run', ...runs.value } }
      : runs;
  }
  if (items.length > MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS) {
    return {
      ok: false,
      code: 'capacity_exceeded',
      message: `A GitHub pull request watcher can include at most ${MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS} pull requests.`,
      field: 'items',
    };
  }
  if (hasInvalidScalarFields(value)) return invalidWatchGitHubItems();
  const notifyOn = normalizePullRequestNotifyOn(value.notifyOn);
  if (!notifyOn.ok) return notifyOn;
  const targets = normalizeGitHubPullRequestTargets({
    items,
    repository: value.repository,
    repositoryCandidates: options.repositoryCandidates,
  });
  if (!targets.ok) return targets;
  return {
    ok: true,
    value: {
      family: 'pull_request',
      items: targets.targets,
      ...(notifyOn.selection ? { notifyOn: notifyOn.selection } : {}),
      ...optionalWatcherFields(value),
    },
  };
}

function isDefaultPullRequestNotificationSelection(
  selection: GitHubPullRequestNotificationSelection,
): boolean {
  return !selection.queueEntered && selection.queuePhases.length === 0;
}

/** `"any"` or a list of known phases, deduplicated in lifecycle order. */
function normalizeQueuePhases(value: unknown): PrMergeQueueKnownPhase[] | null {
  if (value === undefined) return [];
  if (value === 'any') return [...PR_MERGE_QUEUE_KNOWN_PHASES];
  if (!Array.isArray(value) || !value.every(isPrMergeQueueKnownPhase)) {
    return null;
  }
  return PR_MERGE_QUEUE_KNOWN_PHASES.filter((phase) => value.includes(phase));
}

/**
 * Normalize pull request `notifyOn`; `selection` is omitted for the default
 * (absent, `{}`, or a queue selection that selects nothing).
 */
function normalizePullRequestNotifyOn(
  value: unknown,
):
  | { ok: true; selection?: GitHubPullRequestNotificationSelection }
  | Extract<WatchGitHubItemsResult, { ok: false }> {
  if (value === undefined) return { ok: true };
  const notifyOn = recordValue(value);
  if (
    !notifyOn ||
    !hasOnlyKeys(notifyOn, WATCH_GITHUB_PULL_REQUEST_NOTIFY_KEYS)
  ) {
    return invalidWatchGitHubItems(PULL_REQUEST_NOTIFY_ON_MESSAGE, 'notifyOn');
  }
  if (notifyOn.queue === undefined) return { ok: true };
  const queue = recordValue(notifyOn.queue);
  if (
    !queue ||
    !hasOnlyKeys(queue, WATCH_GITHUB_PULL_REQUEST_QUEUE_KEYS) ||
    (queue.entered !== undefined && typeof queue.entered !== 'boolean')
  ) {
    return invalidWatchGitHubItems(PULL_REQUEST_NOTIFY_ON_MESSAGE, 'notifyOn');
  }
  const queuePhases = normalizeQueuePhases(queue.phases);
  if (!queuePhases) {
    return invalidWatchGitHubItems(
      PULL_REQUEST_QUEUE_PHASES_MESSAGE,
      'notifyOn',
    );
  }
  const selection: GitHubPullRequestNotificationSelection = {
    queueEntered: queue.entered === true,
    queuePhases,
  };
  return isDefaultPullRequestNotificationSelection(selection)
    ? { ok: true }
    : { ok: true, selection };
}

/**
 * Validate the bounded workflow-run request envelope without resolving
 * workflow references. Pull request items are rejected; route mixed-family
 * callers through {@link normalizeWatchGitHubItemsFamilyRequest}.
 */
export function normalizeWatchGitHubItemsRequest(
  input: unknown,
): NormalizeWatchGitHubItemsRequestResult {
  const envelope = readWatchGitHubItemsEnvelope(input);
  if (!envelope.ok) return envelope;
  return envelope.family === 'workflow_run'
    ? normalizeWorkflowRunRequest(envelope.value, envelope.items)
    : invalidWatchGitHubItems(
        'Pull request items require the pull request watcher.',
        'items',
      );
}

function findPullRequestUrlAsRun(
  items: unknown[],
): Extract<WatchGitHubItemsResult, { ok: false }> | null {
  const itemIndex = items.findIndex((item) =>
    isGitHubPullRequestUrl(
      isRecord(item) && item.kind === 'workflow_run' ? item.target : item,
    ),
  );
  return itemIndex >= 0
    ? {
        ok: false,
        code: 'invalid_reference',
        message: PULL_REQUEST_URL_AS_RUN_MESSAGE,
        itemIndex,
        field: 'items',
      }
    : null;
}

function normalizeWorkflowRunRequest(
  value: Record<string, unknown>,
  items: unknown[],
): NormalizeWatchGitHubItemsRequestResult {
  const invalid = invalidWatchGitHubItems;
  if (items.length > MAX_GITHUB_WORKFLOW_RUN_WATCH_ITEMS) {
    return {
      ok: false,
      code: 'capacity_exceeded',
      message: 'A GitHub workflow watcher can include at most 20 runs.',
      field: 'items',
    };
  }
  const pullRequestUrlAsRun = findPullRequestUrlAsRun(items);
  if (pullRequestUrlAsRun) return pullRequestUrlAsRun;
  if (!items.every(isWatchGitHubItemInput)) {
    return invalid(undefined, 'items');
  }
  if (hasInvalidScalarFields(value)) return invalid();
  const notifyOn = recordValue(value.notifyOn);
  if (notifyOn && 'queue' in notifyOn) {
    return invalid(WORKFLOW_RUN_QUEUE_MESSAGE, 'notifyOn');
  }
  if (!notifyOn || !hasOnlyKeys(notifyOn, WATCH_GITHUB_NOTIFY_KEYS)) {
    return invalid(undefined, 'notifyOn');
  }
  const run = notifyOn.run === undefined ? null : recordValue(notifyOn.run);
  const jobs = notifyOn.jobs === undefined ? null : recordValue(notifyOn.jobs);
  if (
    (notifyOn.run !== undefined &&
      (!run || !hasOnlyKeys(run, WATCH_GITHUB_RUN_NOTIFY_KEYS))) ||
    (notifyOn.jobs !== undefined &&
      (!jobs || !hasOnlyKeys(jobs, WATCH_GITHUB_JOB_NOTIFY_KEYS)))
  ) {
    return invalid(undefined, 'notifyOn');
  }
  const runStatuses = run?.statuses ?? notifyOn.statuses;
  const runConclusions = run?.conclusions ?? notifyOn.conclusions;
  const jobConclusions = jobs?.conclusions;
  if (
    runStatuses === undefined &&
    runConclusions === undefined &&
    jobConclusions === undefined
  ) {
    return invalid(
      'Select notifyOn.run statuses/conclusions or notifyOn.jobs conclusions.',
      'notifyOn',
    );
  }
  const statuses =
    runStatuses === undefined
      ? []
      : normalizeSelection(
          runStatuses,
          GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
        );
  const conclusions =
    runConclusions === undefined
      ? []
      : normalizeSelection(runConclusions, GITHUB_WORKFLOW_RUN_CONCLUSIONS);
  const normalizedJobConclusions =
    jobConclusions === undefined
      ? []
      : normalizeSelection(jobConclusions, GITHUB_WORKFLOW_JOB_CONCLUSIONS);
  if (
    !statuses ||
    !conclusions ||
    !normalizedJobConclusions ||
    statuses.length + conclusions.length + normalizedJobConclusions.length === 0
  ) {
    return invalid(undefined, 'notifyOn');
  }
  return {
    ok: true,
    value: {
      items,
      notifyOn: {
        statuses,
        conclusions,
        jobConclusions: normalizedJobConclusions,
      },
      ...(typeof value.repository === 'string'
        ? { repository: value.repository }
        : {}),
      ...optionalWatcherFields(value),
    },
  };
}

/** Validate and canonicalize a model-supplied WatchGitHubItems request. */
export function normalizeWatchGitHubItemsInput(
  input: unknown,
): NormalizeWatchGitHubItemsResult {
  const request = normalizeWatchGitHubItemsRequest(input);
  if (!request.ok) return request;
  const value = recordValue(input);
  const invalid = (
    message = 'Invalid WatchGitHubItems input.',
  ): Extract<WatchGitHubItemsResult, { ok: false }> => ({
    ok: false,
    code: 'invalid_input',
    message,
  });
  if (!value) return invalid();
  if (
    (value.label !== undefined && typeof value.label !== 'string') ||
    (value.followUpInstruction !== undefined &&
      typeof value.followUpInstruction !== 'string') ||
    (value.allowDuplicate !== undefined &&
      typeof value.allowDuplicate !== 'boolean')
  ) {
    return invalid();
  }

  const sourceIndexByKey = new Map<string, number>();
  const items: NormalizedWatchGitHubItemsInput['items'] = [];
  for (let index = 0; index < request.value.items.length; index += 1) {
    const item = recordValue(request.value.items[index]);
    if (
      !item ||
      !hasOnlyKeys(item, WATCH_GITHUB_ITEM_KEYS) ||
      item.kind !== 'workflow_run'
    ) {
      return invalid();
    }
    const repository = normalizeRepository(item.repository);
    const runId = normalizeRunId(item.runId);
    const requestedAttempt =
      item.requestedAttempt === undefined
        ? undefined
        : typeof item.requestedAttempt === 'number' &&
            Number.isSafeInteger(item.requestedAttempt) &&
            item.requestedAttempt > 0
          ? item.requestedAttempt
          : null;
    if (!repository || !runId || requestedAttempt === null) return invalid();
    const key = `${repository}/${runId}/${requestedAttempt ?? ''}`;
    if (sourceIndexByKey.has(key)) {
      return {
        ok: false,
        code: 'duplicate_item',
        message: 'The same GitHub workflow run was supplied more than once.',
        itemIndex: index,
      };
    }
    sourceIndexByKey.set(key, index);
    items.push({
      kind: 'workflow_run',
      repository,
      runId,
      ...(requestedAttempt ? { requestedAttempt } : {}),
    });
  }

  const { statuses, conclusions, jobConclusions } = request.value.notifyOn;

  items.sort((left, right) => {
    const repositoryOrder = left.repository.localeCompare(right.repository);
    return repositoryOrder !== 0
      ? repositoryOrder
      : BigInt(left.runId) < BigInt(right.runId)
        ? -1
        : BigInt(left.runId) > BigInt(right.runId)
          ? 1
          : (left.requestedAttempt ?? 0) - (right.requestedAttempt ?? 0);
  });
  return {
    ok: true,
    value: {
      items,
      notifyOn: { statuses, conclusions, jobConclusions },
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      ...(typeof value.followUpInstruction === 'string'
        ? { followUpInstruction: value.followUpInstruction }
        : {}),
      ...(typeof value.allowDuplicate === 'boolean'
        ? { allowDuplicate: value.allowDuplicate }
        : {}),
    },
    sourceIndexByKey,
  };
}

/** Compact event-kind confirmation returned by WatchGitHubItems. */
export function githubWatcherEventKinds(
  notifyOn: NormalizedWatchGitHubItemsInput['notifyOn'],
): Array<'workflow_run_transition' | 'workflow_job_completed'> {
  return [
    ...(notifyOn.statuses.length > 0 || notifyOn.conclusions.length > 0
      ? (['workflow_run_transition'] as const)
      : []),
    ...(notifyOn.jobConclusions.length > 0
      ? (['workflow_job_completed'] as const)
      : []),
  ];
}

/**
 * Event kinds a pull request watcher arms: merge, close, queue removal, and
 * unrecoverable queue history always; queue entry and phase when selected.
 */
export function githubPullRequestWatcherEventKinds(
  notifyOn?: GitHubPullRequestNotificationSelection,
): GitHubPullRequestWatcherEventKind[] {
  return [
    'pull_request_merged',
    'pull_request_closed',
    'pull_request_queue_removed',
    'pull_request_queue_history_incomplete',
    ...(notifyOn?.queueEntered
      ? (['pull_request_queue_entered'] as const)
      : []),
    ...(notifyOn && notifyOn.queuePhases.length > 0
      ? (['pull_request_queue_phase_changed'] as const)
      : []),
  ];
}

const MAX_GITHUB_WATCHER_DISPLAY_SAMPLES = 5;

/** Persisted only when it differs from the default; phases are unique. */
function isPersistedPullRequestNotificationSelection(
  value: unknown,
): value is GitHubPullRequestNotificationSelection {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['queueEntered', 'queuePhases']) ||
    typeof value.queueEntered !== 'boolean' ||
    !Array.isArray(value.queuePhases) ||
    !value.queuePhases.every(isPrMergeQueueKnownPhase) ||
    new Set(value.queuePhases).size !== value.queuePhases.length
  ) {
    return false;
  }
  return !isDefaultPullRequestNotificationSelection({
    queueEntered: value.queueEntered,
    queuePhases: value.queuePhases,
  });
}

/** Strict shape check for a persisted `github_pull_requests` target. */
export function isPersistedGitHubPullRequestTarget(
  value: unknown,
): value is Extract<AppAdvisorWatcherTarget, { kind: 'github_pull_requests' }> {
  if (
    !isRecord(value) ||
    value.kind !== 'github_pull_requests' ||
    !hasOnlyKeys(value, ['kind', 'items', 'notifyOn', 'display']) ||
    (value.notifyOn !== undefined &&
      !isPersistedPullRequestNotificationSelection(value.notifyOn)) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS ||
    !isRecord(value.display)
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['kind', 'repository', 'number']) ||
      item.kind !== 'pull_request' ||
      typeof item.repository !== 'string' ||
      normalizeGitHubRepositoryReference(item.repository) !== item.repository ||
      typeof item.number !== 'number' ||
      normalizeGitHubPullRequestNumber(item.number) !== item.number
    ) {
      return false;
    }
    keys.add(`${item.repository}#${item.number}`);
  }
  const { repositories, sample } = value.display;
  return (
    keys.size === value.items.length &&
    Array.isArray(repositories) &&
    repositories.length <= MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS &&
    repositories.every((entry) => typeof entry === 'string') &&
    Array.isArray(sample) &&
    sample.length <= MAX_GITHUB_WATCHER_DISPLAY_SAMPLES &&
    sample.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.repository === 'string' &&
        normalizeGitHubPullRequestNumber(entry.number) === entry.number &&
        (entry.title === undefined || typeof entry.title === 'string'),
    )
  );
}

/** Strip renderer-only destination/target metadata from provider setup output. */
export function projectSetupWatchersResultForProvider(
  result: SetupAppAdvisorWatchersResult | CanonicalChatWatcherSetupResult,
): unknown {
  if (!result.ok) return result;
  return {
    ok: true,
    results: result.results.map((entry) => {
      const { watcher } = entry;
      // Canonical projections are already authorized and redaction-safe. Do
      // not assume an unavailable projection has a target, or reconstruct one.
      if (!watcher.target || !('kind' in watcher.target)) {
        return { status: entry.status, watcher: { ...watcher } };
      }
      return {
        status: entry.status,
        watcher: {
          id: watcher.id,
          trigger: watcher.trigger,
          status: watcher.status,
          label: watcher.label,
          targetKind: watcher.target.kind,
        },
      };
    }),
  };
}

export function rankHookTriggers(
  hookTriggers: readonly HookWatcherTriggerCatalogEntry[],
  query: string,
): HookWatcherTriggerCatalogEntry[] {
  return rankAgentWatcherHookTriggers(hookTriggers, query);
}

/**
 * Brief human-readable description of a fired watcher for the chat
 * transcript's "<kind> watcher has fired" title line: the trigger kind plus
 * basic target info (chat title, pipeline name, hook name, repository).
 * Shared by the main-process watcher scheduler (which stamps it onto every
 * delivered watcher message as `watcherFired`, whether main queues it itself
 * or hands a terminal-backed chat's message to the window) and tests so every
 * surface derives the same copy.
 */
export function describeWatcherFiredKind(watcher: {
  trigger: AppAdvisorWatcherTriggerType;
  target: AppAdvisorWatcherTarget;
}): string {
  const withDetail = (label: string, detail?: string): string => {
    const trimmed = detail?.trim();
    return trimmed ? `${label} (${trimmed})` : label;
  };
  const { target } = watcher;
  switch (target.kind) {
    case 'scheduled_wakeup':
      return 'Scheduled wakeup';
    case 'command_watch':
      return 'Watch command';
    case 'worktree_chat':
    case 'standalone_chat':
      return withDetail('Chat completion', target.chatTitle);
    case 'worktree_chat_scope':
      return withDetail('New chat', target.worktreeBranchName);
    case 'standalone_chat_project':
      return withDetail('New chat', target.projectName);
    case 'worktree_pipeline':
      return withDetail('Workflow completion', target.pipelineName);
    case 'worktree_hook':
      return withDetail(
        'Hook',
        target.hookLabel ?? getHookTriggerDisplayName(target.triggerName),
      );
    case 'automation':
      return withDetail('Automation run', target.automationName);
    case 'github_pull_requests': {
      const [first] = target.items;
      return withDetail(
        'GitHub pull request',
        target.items.length === 1 && first
          ? `${first.repository}#${first.number}`
          : `${target.items.length} pull requests`,
      );
    }
    case 'github_workflow_runs': {
      const repositories =
        target.display.repositories.length > 0
          ? target.display.repositories
          : Array.from(new Set(target.items.map((item) => item.repository)));
      return withDetail(
        'GitHub workflow run',
        repositories.length === 1
          ? repositories[0]
          : `${repositories.length} repositories`,
      );
    }
  }
}
