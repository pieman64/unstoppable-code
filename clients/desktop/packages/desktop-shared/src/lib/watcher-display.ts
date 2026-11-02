// Pure display helpers for App Advisor watcher rows. Shared between the
// existing `AppAdvisorWatcherIndicator` composer button, the new
// `WatcherManagementButton`/`WatcherManagementModal` components, the
// Automations Watchers tab, and any future surface that needs to render a
// watcher row without re-deriving display strings.

import { CHAT_LABEL, ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  GITHUB_WORKFLOW_JOB_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_CONCLUSIONS,
  GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
  getModelDisplayName,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWatcherOwnerDelegate,
  type AppAdvisorWatcherStatus,
  type AppAdvisorWatcherSummary,
  type AppAdvisorWatcherTarget,
  type AppAdvisorWatcherTriggerType,
} from '@canopy/desktop-shared/types';
import {
  APP_ADVISOR_WATCHER_CATALOG,
  type AppAdvisorWatcherCatalogEntry,
} from '@canopy/desktop-shared/lib/app-advisor-watchers';
import { PR_MERGE_QUEUE_KNOWN_PHASES } from '@canopy/desktop-shared/lib/pr-merge-queue';
import type { GitHubPullRequestNotificationSelection } from '@canopy/desktop-shared/types/github-watchers';
import { getHookTriggerDisplayName } from '@canopy/desktop-shared/hooks';

const UNKNOWN_WORKSPACE = 'Unknown project';
const UNKNOWN_WORKTREE = 'Unknown branch';
const UNKNOWN_CHAT = 'Untitled chat';
const UNKNOWN_PIPELINE = 'Workflow';
const UNKNOWN_PROJECT = 'Standalone chat';

/**
 * Known trigger titles that may not yet be present in the shared catalog. The
 * GitHub workflow-run catalog row value is populated by the backend plan; this
 * fallback keeps the Automations "Trigger" column and the watcher tooltip
 * correct even when the renderer runs ahead of that catalog entry.
 */
const TRIGGER_TITLE_FALLBACKS: Partial<
  Record<AppAdvisorWatcherTriggerType, string>
> = {
  github_workflow_runs_changed: 'GitHub workflow runs changed',
};

/**
 * Map a watcher's trigger key to the catalog title the assistant uses when it
 * sets the watcher up. Falls back to a known static title (see
 * {@link TRIGGER_TITLE_FALLBACKS}) and finally to the raw trigger key if the
 * catalog ever drifts ahead of the renderer (e.g. a brand-new trigger lands in
 * the shared package before the renderer ships a new build).
 */
export function triggerTitle(trigger: AppAdvisorWatcherTriggerType): string {
  const entry: AppAdvisorWatcherCatalogEntry | undefined =
    APP_ADVISOR_WATCHER_CATALOG.find((row) => row.trigger === trigger);
  return entry?.title ?? TRIGGER_TITLE_FALLBACKS[trigger] ?? trigger;
}

/**
 * Human-readable label for a watcher's runtime status. Anything other than
 * the renderer-visible statuses (`active`, `delivery_failed`) falls through
 * to the raw key — the backend filter prevents those from reaching us, but
 * keeping the fallback avoids a `??` chain in callers.
 */
export function watcherStatusLabel(status: AppAdvisorWatcherStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'delivery_failed':
      return 'Delivery failed';
    case 'firing':
      return 'Firing';
    case 'fired':
      return 'Fired';
    default:
      return status;
  }
}

/**
 * Status label that folds in the backend-supplied `failureKind` so GitHub
 * workflow-run watchers can distinguish a delivery failure (the watcher fired
 * but the subscribing chat could not be notified) from a source failure (the
 * watched GitHub runs became inaccessible). Falls back to the plain
 * {@link watcherStatusLabel} for every watcher that carries no `failureKind`,
 * so existing (non-GitHub) failure copy is unchanged.
 *
 * - `failureKind: 'delivery'` → `Delivery failed`
 * - `failureKind: 'source'`   → `Source unavailable`
 * - no `failureKind`          → {@link watcherStatusLabel}
 */
export function watcherStatusLabelWithFailure(
  status: AppAdvisorWatcherStatus,
  failureKind?: 'delivery' | 'source',
): string {
  if (failureKind === 'source') return 'Source unavailable';
  if (failureKind === 'delivery') return 'Delivery failed';
  return watcherStatusLabel(status);
}

/** Provider/model summary shown under chat-style watchers. */
function providerDisplay(target: AppAdvisorWatcherTarget): string | null {
  if (target.kind === 'scheduled_wakeup' || target.kind === 'command_watch')
    return null;
  if (
    target.kind === 'worktree_pipeline' ||
    target.kind === 'worktree_hook' ||
    target.kind === 'worktree_chat_scope' ||
    target.kind === 'standalone_chat_project' ||
    target.kind === 'automation' ||
    target.kind === 'github_workflow_runs' ||
    target.kind === 'github_pull_requests'
  ) {
    return null;
  }
  const provider =
    target.providerType === 'claude'
      ? 'Claude'
      : target.providerType === 'codex'
        ? 'Codex'
        : target.providerType === 'ollama'
          ? 'Ollama'
          : null;
  const model = target.model ? getModelDisplayName(target.model) : null;
  if (provider && model) return `${provider} · ${model}`;
  return provider ?? model;
}

/** Terminal status line shown under pipeline watcher rows. */
function terminalStatusDisplay(target: AppAdvisorWatcherTarget): string | null {
  if (target.kind !== 'worktree_pipeline') return null;
  const statuses = target.terminalStatuses?.length
    ? target.terminalStatuses
    : ['success', 'failure', 'cancelled'];
  return statuses
    .map((status) =>
      status === 'success'
        ? 'Success'
        : status === 'failure'
          ? 'Failure'
          : 'Cancelled',
    )
    .join(', ');
}

/** Rendered fields for a watcher's `target`. */
export interface WatcherTargetDisplay {
  /** Primary line (chat title / pipeline name). */
  title: string;
  /** Secondary line (workspace / branch / project). */
  subtitle: string;
  /** Long-form key/value pairs used in the management modal body. */
  details: Array<{ label: string; value: string }>;
}

/** One persisted display sample run for a `github_workflow_runs` watcher. */
export interface GitHubWatcherSampleRun {
  repository: string;
  runId: string;
  runAttempt: number;
  requestedAttempt?: number;
  workflowName?: string;
  runNumber?: number;
}

/**
 * GitHub-specific display fields for a `github_workflow_runs` target. Every
 * surface (chat Watching tooltip/modal, App Advisor, Automations table) renders
 * these through one shared helper so the grouped watcher is presented
 * identically everywhere: one bounded subtitle, the selected notify filters,
 * and a bounded sample of the watched runs — never all twenty.
 */
export interface GitHubWatcherTargetDisplay {
  /** e.g. `20 workflow runs in 2 repositories`. */
  subtitle: string;
  /** `Intermediate: any` / `Terminal: failure, success` style rows. */
  filters: Array<{ label: string; value: string }>;
  /** Persisted display sample (already capped to five by the backend). */
  sample: GitHubWatcherSampleRun[];
  /** Total watched runs (1–20). Drives the `+N more` overflow count. */
  totalCount: number;
  /** Unique repository count represented by the watched runs. */
  repositoryCount: number;
}

/** Maximum persisted/rendered sample runs for a grouped GitHub watcher. */
const MAX_GITHUB_SAMPLE_RUNS = 5;

/**
 * True when a normalized notify selection covers the entire enum — the
 * compact `any` alias is expanded to the full enum before persistence, so a
 * full-length, all-members selection is rendered back as `any`.
 */
function isAnySelection<T extends string>(
  selected: readonly T[],
  all: readonly T[],
): boolean {
  return (
    selected.length === all.length &&
    all.every((value) => selected.includes(value))
  );
}

/**
 * Bounded display projection for a `github_workflow_runs` target, or `null`
 * for every other target kind. Values come from the persisted
 * `AppAdvisorWatcherTarget.display`/`notifyOn`; the backend guarantees
 * `display.sample` holds at most five entries and `display.repositories` is
 * unique + sorted, but we defensively derive/clamp here so a drifted record
 * never renders all twenty runs.
 */
export function githubWatcherTargetDisplay(
  target: AppAdvisorWatcherTarget,
): GitHubWatcherTargetDisplay | null {
  if (target.kind !== 'github_workflow_runs') return null;

  const totalCount = target.items.length;
  const repositories =
    target.display.repositories.length > 0
      ? target.display.repositories
      : Array.from(new Set(target.items.map((item) => item.repository)));
  const repositoryCount = repositories.length;

  const runWord = totalCount === 1 ? 'workflow run' : 'workflow runs';
  const subtitle =
    repositoryCount <= 1
      ? `${totalCount} ${runWord} in ${repositories[0] ?? 'an unknown repository'}`
      : `${totalCount} ${runWord} in ${repositoryCount} repositories`;

  const filters: Array<{ label: string; value: string }> = [];
  if (target.notifyOn.statuses.length > 0) {
    filters.push({
      label: 'Intermediate',
      value: isAnySelection(
        target.notifyOn.statuses,
        GITHUB_WORKFLOW_RUN_INTERMEDIATE_STATUSES,
      )
        ? 'any'
        : target.notifyOn.statuses.join(', '),
    });
  }
  if (target.notifyOn.conclusions.length > 0) {
    filters.push({
      label: 'Terminal',
      value: isAnySelection(
        target.notifyOn.conclusions,
        GITHUB_WORKFLOW_RUN_CONCLUSIONS,
      )
        ? 'any'
        : target.notifyOn.conclusions.join(', '),
    });
  }
  const jobConclusions = target.notifyOn.jobConclusions ?? [];
  if (jobConclusions.length > 0) {
    filters.push({
      label: 'Jobs completed',
      value: isAnySelection(jobConclusions, GITHUB_WORKFLOW_JOB_CONCLUSIONS)
        ? 'any'
        : jobConclusions.join(', '),
    });
  }

  return {
    subtitle,
    filters,
    sample: target.display.sample
      .slice(0, MAX_GITHUB_SAMPLE_RUNS)
      .map((sample): GitHubWatcherSampleRun => {
        const selected = target.items.find(
          (item) =>
            item.repository === sample.repository &&
            item.runId === sample.runId &&
            (item.requestedAttempt === undefined ||
              item.requestedAttempt === sample.runAttempt),
        );
        return {
          ...sample,
          ...(selected?.requestedAttempt
            ? { requestedAttempt: selected.requestedAttempt }
            : {}),
        };
      }),
    totalCount,
    repositoryCount,
  };
}

/**
 * Short label for one sampled GitHub workflow run, preferring the workflow
 * name + run number and falling back to the run id when GitHub did not supply
 * them. Always suffixed with the repository so multi-repo watchers stay
 * unambiguous.
 */
export function formatGitHubRunSampleLabel(
  run: GitHubWatcherSampleRun,
): string {
  const workflowName = run.workflowName?.trim();
  const runRef = run.runNumber != null ? `#${run.runNumber}` : `#${run.runId}`;
  const lead = workflowName ? `${workflowName} ${runRef}` : `Run ${runRef}`;
  const attempt =
    run.runAttempt > 1 || run.requestedAttempt !== undefined
      ? ` · attempt ${run.runAttempt}`
      : '';
  return `${lead} · ${run.repository}${attempt}`;
}

/**
 * Number of watched runs beyond the `shownCount` already rendered. Callers pass
 * how many sample rows they displayed (three in a tooltip, five in a
 * modal/table) and render `+{overflow} more` when this is positive.
 */
export function githubRunSampleOverflow(
  display: GitHubWatcherTargetDisplay,
  shownCount: number,
): number {
  return Math.max(0, display.totalCount - shownCount);
}

function mergeQueuePhaseLabel(phase: string): string {
  return phase.replace(/_/g, ' ');
}

function isAnyMergeQueuePhase(
  notifyOn: GitHubPullRequestNotificationSelection,
): boolean {
  return isAnySelection(notifyOn.queuePhases, PR_MERGE_QUEUE_KNOWN_PHASES);
}

/** Subtitle suffix for selected queue options; empty for the default. */
function githubPullRequestQueueSuffix(
  notifyOn: GitHubPullRequestNotificationSelection | undefined,
): string {
  if (!notifyOn) return '';
  const options = [
    ...(notifyOn.queueEntered ? ['queue entry'] : []),
    ...(isAnyMergeQueuePhase(notifyOn)
      ? ['any queue phase']
      : notifyOn.queuePhases.map(mergeQueuePhaseLabel)),
  ];
  return options.length > 0 ? ` · also ${options.join(', ')}` : '';
}

/** Optional merge queue notifications; empty for the default selection. */
function githubPullRequestQueueDetails(
  notifyOn: GitHubPullRequestNotificationSelection | undefined,
): Array<{ label: string; value: string }> {
  if (!notifyOn) return [];
  const details: Array<{ label: string; value: string }> = [];
  if (notifyOn.queueEntered) {
    details.push({ label: 'Queue entry', value: 'Entered or re-entered' });
  }
  if (notifyOn.queuePhases.length > 0) {
    details.push({
      label: 'Queue phases',
      value: isAnyMergeQueuePhase(notifyOn)
        ? 'any'
        : notifyOn.queuePhases.map(mergeQueuePhaseLabel).join(', '),
    });
  }
  return details;
}

function githubPullRequestTargetDisplay(
  target: Extract<AppAdvisorWatcherTarget, { kind: 'github_pull_requests' }>,
): WatcherTargetDisplay {
  const references = target.items.map(
    (item) => `${item.repository}#${item.number}`,
  );
  const shown = references.slice(0, MAX_GITHUB_SAMPLE_RUNS);
  const overflow = references.length - shown.length;
  const [first] = target.items;
  const firstTitle = first
    ? target.display.sample
        .find(
          (sample) =>
            sample.repository === first.repository &&
            sample.number === first.number,
        )
        ?.title?.trim()
    : undefined;
  const single = references.length === 1;
  const repositories = Array.from(
    new Set(target.items.map((item) => item.repository)),
  );
  const where =
    repositories.length === 1
      ? `in ${repositories[0]}`
      : `in ${repositories.length} repositories`;
  return {
    title: single ? references[0] : `${references.length} pull requests`,
    subtitle: `${
      single
        ? firstTitle || 'Merged, closed, or removed from the queue'
        : `${where} · merged, closed, or removed from the queue`
    }${githubPullRequestQueueSuffix(target.notifyOn)}`,
    details: [
      {
        label: 'Notifies on',
        value:
          'Merged, closed without merging, or removed from the merge queue',
      },
      ...githubPullRequestQueueDetails(target.notifyOn),
      ...(single
        ? []
        : [
            {
              label: 'Pull requests',
              value: `${shown.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`,
            },
          ]),
    ],
  };
}

export function watcherTargetDisplay(
  target: AppAdvisorWatcherTarget,
): WatcherTargetDisplay {
  if (target.kind === 'scheduled_wakeup')
    return {
      title: 'Scheduled wakeup',
      subtitle: new Date(target.scheduledFor).toLocaleString(),
      details: [{ label: 'Delay', value: `${target.delaySeconds} seconds` }],
    };
  if (target.kind === 'command_watch')
    return {
      title: target.command,
      subtitle: `Every ${target.intervalSeconds}s · up to ${target.maxAttempts} attempts`,
      details: [
        { label: 'Directory', value: target.cwd },
        { label: 'Attempt timeout', value: '60 seconds' },
      ],
    };
  if (target.kind === 'github_workflow_runs') {
    const github = githubWatcherTargetDisplay(target);
    return {
      title: 'GitHub workflow runs',
      subtitle: github?.subtitle ?? '',
      details: github?.filters ?? [],
    };
  }

  if (target.kind === 'github_pull_requests') {
    return githubPullRequestTargetDisplay(target);
  }

  if (target.kind === 'worktree_chat') {
    const workspace = target.workspaceName?.trim() || UNKNOWN_WORKSPACE;
    const branch = target.worktreeBranchName?.trim() || UNKNOWN_WORKTREE;
    const chat = target.chatTitle?.trim() || UNKNOWN_CHAT;
    const provider = providerDisplay(target);
    return {
      title: chat,
      subtitle: `${workspace} / ${branch}`,
      details: [
        { label: 'Project', value: workspace },
        { label: 'Branch', value: branch },
        { label: `${CHAT_LABEL} tab`, value: chat },
        ...(target.chatDescription?.trim()
          ? [{ label: 'Description', value: target.chatDescription.trim() }]
          : []),
        ...(provider ? [{ label: 'Provider', value: provider }] : []),
      ],
    };
  }

  if (target.kind === 'standalone_chat') {
    const project = target.projectName?.trim() || UNKNOWN_PROJECT;
    const chat = target.chatTitle?.trim() || UNKNOWN_CHAT;
    const provider = providerDisplay(target);
    return {
      title: chat,
      subtitle: project,
      details: [
        { label: 'Project', value: project },
        { label: `${CHAT_LABEL} tab`, value: chat },
        ...(target.chatDescription?.trim()
          ? [{ label: 'Description', value: target.chatDescription.trim() }]
          : []),
        ...(provider ? [{ label: 'Provider', value: provider }] : []),
      ],
    };
  }

  if (target.kind === 'worktree_chat_scope') {
    const workspace = target.workspaceName?.trim() || UNKNOWN_WORKSPACE;
    const branch = target.worktreeBranchName?.trim() || UNKNOWN_WORKTREE;
    return {
      title: branch,
      subtitle: workspace,
      details: [
        { label: 'Project', value: workspace },
        { label: 'Branch', value: branch },
        { label: 'Scope', value: 'New chats in this worktree' },
      ],
    };
  }

  if (target.kind === 'standalone_chat_project') {
    const project = target.projectName?.trim() || UNKNOWN_PROJECT;
    return {
      title: project,
      subtitle: 'Standalone chat project',
      details: [
        { label: 'Project', value: project },
        { label: 'Scope', value: 'New chats in this project' },
      ],
    };
  }

  if (target.kind === 'automation') {
    const automation = target.automationName?.trim() || target.automationId;
    return {
      title: automation,
      subtitle: 'Automation run',
      details: [
        { label: 'Automation', value: automation },
        { label: 'Automation id', value: target.automationId },
        {
          label: 'Scope',
          value: 'Next run outcome, including its dispatched work',
        },
      ],
    };
  }

  if (target.kind === 'worktree_hook') {
    const workspace = target.workspaceName?.trim() || UNKNOWN_WORKSPACE;
    const branch = target.worktreeBranchName?.trim() || UNKNOWN_WORKTREE;
    const hook =
      target.hookLabel?.trim() || getHookTriggerDisplayName(target.triggerName);
    return {
      title: hook,
      subtitle: `${workspace} / ${branch}`,
      details: [
        { label: 'Project', value: workspace },
        { label: 'Branch', value: branch },
        {
          label: 'Hook trigger',
          value: getHookTriggerDisplayName(target.triggerName),
        },
        { label: 'Trigger key', value: target.triggerName },
        ...(target.hookKey
          ? [{ label: 'Hook key', value: target.hookKey }]
          : []),
        ...(target.scope ? [{ label: 'Scope', value: target.scope }] : []),
        ...(target.repoId
          ? [{ label: 'Repo', value: target.repoName ?? target.repoId }]
          : []),
      ],
    };
  }

  const workspace = target.workspaceName?.trim() || UNKNOWN_WORKSPACE;
  const branch = target.worktreeBranchName?.trim() || UNKNOWN_WORKTREE;
  const pipeline = target.pipelineName?.trim() || UNKNOWN_PIPELINE;
  const statuses = terminalStatusDisplay(target);
  return {
    title: pipeline,
    subtitle: `${workspace} / ${branch}`,
    details: [
      { label: 'Project', value: workspace },
      { label: 'Branch', value: branch },
      { label: 'Workflow', value: pipeline },
      ...(target.pipelineDescription?.trim()
        ? [{ label: 'Description', value: target.pipelineDescription.trim() }]
        : []),
      {
        label: 'Scope',
        value: target.executionId
          ? 'Current execution'
          : 'Future matching runs',
      },
      ...(statuses ? [{ label: 'Terminal states', value: statuses }] : []),
    ],
  };
}

export function localWatcherProgressLabel(
  watcher: AppAdvisorWatcherSummary,
): string | undefined {
  const progress = watcher.localProgress;
  if (!progress) return undefined;
  if (progress.outcome) {
    const reason = progress.reason;
    let reasonLabel: string;
    if (reason?.startsWith('capture_error:'))
      reasonLabel = 'Could not capture command output';
    else if (reason?.startsWith('recovery_error:'))
      reasonLabel = 'Could not recover command result';
    else if (reason?.startsWith('spawn_error:'))
      reasonLabel = 'Could not start command';
    else {
      reasonLabel =
        {
          scheduled_wakeup: 'Wakeup time reached',
          execution_scope_unavailable: 'Worktree no longer available',
          interrupted: 'Interrupted during restart',
          exit_zero: 'Command succeeded',
          max_attempts: 'Maximum attempts reached',
          exit_status: 'Command exited with an error',
          output_limit: 'Output limit reached',
          signal: 'Command stopped by a signal',
          timeout: 'Attempt timed out',
          cancelled: 'Cancelled',
        }[reason ?? ''] ??
        (progress.outcome === 'success'
          ? 'Completed'
          : 'Command did not complete');
    }
    return `${progress.outcome === 'success' ? 'Succeeded' : 'Failed'} · ${reasonLabel}`;
  }
  return `${watcher.target.kind === 'command_watch' ? `${progress.attempts} / ${watcher.target.maxAttempts} attempts · Next: ` : 'Wakeup: '}${new Date(progress.nextAttemptAt).toLocaleString()}`;
}

/** The chat store's worktree tab lists, as far as watcher labels need them. */
export type WatcherChatTabsLookup = Readonly<
  Record<
    string,
    { readonly tabs: ReadonlyArray<{ id: string; title?: string }> } | undefined
  >
>;

/**
 * The subscribing chat's current tab title, so a rename shows. `undefined`
 * when the chat's tabs are not loaded.
 */
export function liveWatcherDestinationTitle(
  worktreeChats: WatcherChatTabsLookup,
  destination: AppAdvisorWatcherDestination,
): string | undefined {
  return (
    worktreeChats[`${destination.projectId}/${destination.worktreeId}`]?.tabs
      .find((tab) => tab.id === destination.chatId)
      ?.title?.trim() || undefined
  );
}

/**
 * Short label for a watcher's `destination` (subscribing chat). `liveTitle`
 * (see {@link liveWatcherDestinationTitle}) wins over the recorded title.
 */
export function watcherDestinationDisplay(
  destination: AppAdvisorWatcherDestination,
  liveTitle?: string,
): string {
  const title = liveTitle?.trim() || destination.chatTitle?.trim();
  if (isAppAdvisorDestination(destination)) {
    return title || ORCHESTRATOR_LABEL;
  }
  return title || UNKNOWN_CHAT;
}

/** Names the delegate that created a watcher, and its depth when recorded. */
export function watcherOwnerDelegateDisplay(
  owner: AppAdvisorWatcherOwnerDelegate,
): { name: string; detail?: string } {
  return {
    name: owner.description?.trim() || 'Unnamed delegate',
    ...(owner.depth !== undefined ? { detail: `depth ${owner.depth}` } : {}),
  };
}

/**
 * True when a destination points at an App Advisor chat (entry-keyed
 * `(app-advisor, <workEntryId>)` or the legacy `global` slot). Recognition is
 * project-only — the reserved `app-advisor` id cannot collide with a real
 * workspace, so a foreign destination whose worktreeId happens to be
 * `'global'` is never misclassified. Jump-to-subscriber routes these
 * destinations through `window.api.appAdvisor.openWindow(...)` instead of
 * the main-window chat store.
 */
export function isAppAdvisorDestination(
  destination: AppAdvisorWatcherDestination,
): boolean {
  return destination.projectId === APP_ADVISOR_PROJECT_ID;
}
