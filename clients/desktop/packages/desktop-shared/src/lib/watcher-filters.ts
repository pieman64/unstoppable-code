// Pure filter helpers for the App Advisor watcher list. They keep the
// renderer-visible filter rules (`active` + `delivery_failed` only, never
// `firing`/`fired`) and the per-surface match semantics in a single place so
// pipeline cards, the pipeline-details modal, chat panels, and the
// Automations Watchers tab all agree on what counts as "this surface is
// being watched."
//
// These helpers do not subscribe to the watcher store directly — they take a
// snapshot array and return a (possibly empty) filtered slice. Consumers
// remain responsible for subscribing through `useAppAdvisorWatchersStore` so
// React re-renders when the underlying list changes.

import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherSummary,
} from '@canopy/desktop-shared/types';

/**
 * Render-visible watcher predicate. Mirrors the backend filter rule: the App
 * Advisor service hides `firing` (transient) and `fired` (terminal,
 * diagnostic-only) rows from renderer snapshots, but we re-apply the filter
 * defensively in case a caller passes an unfiltered list (e.g. raw store
 * state or test fixtures).
 */
export function visibleWatchers(
  watchers: AppAdvisorWatcherSummary[],
): AppAdvisorWatcherSummary[] {
  return watchers.filter(
    (watcher) =>
      watcher.status === 'active' || watcher.status === 'delivery_failed',
  );
}

/**
 * Coordinates a pipeline execution lives at. Callers may know any combination
 * of the execution id (single-row scope), the pipeline id (future-runs
 * scope), and the worktree (whole-worktree scope). Each watcher target then
 * matches against the most specific scope it carries.
 */
export interface PipelineExecutionMatch {
  projectId?: string;
  worktreeId?: string;
  executionId?: string;
  pipelineId?: string;
}

/**
 * Return the watchers that should light up on a pipeline execution surface
 * (activity cards, pipeline-detail modal). Match semantics, in priority
 * order:
 *
 *  1. A `worktree_pipeline_completion` watcher's target project/worktree
 *     must match the execution.
 *  2. If the watcher target pins an `executionId`, only that single
 *     execution matches.
 *  3. Otherwise if the watcher target pins a `pipelineId`, every execution
 *     of that pipeline in the same worktree matches.
 *  4. A bare worktree-level pipeline watcher (no `executionId`,
 *     no `pipelineId`) matches every pipeline execution in that worktree.
 *
 * The function deliberately does not consider terminal watcher statuses
 * (`firing`/`fired`) — those are filtered out by {@link visibleWatchers} as a
 * defensive check.
 */
export function watchersForPipelineExecution(
  watchers: AppAdvisorWatcherSummary[],
  execution: PipelineExecutionMatch,
): AppAdvisorWatcherSummary[] {
  return visibleWatchers(watchers).filter((watcher) => {
    if (watcher.trigger !== 'worktree_pipeline_completion') return false;
    if (watcher.target.kind !== 'worktree_pipeline') return false;

    if (execution.projectId !== undefined) {
      if (watcher.target.projectId !== execution.projectId) return false;
    }
    if (execution.worktreeId !== undefined) {
      if (watcher.target.worktreeId !== execution.worktreeId) return false;
    }

    if (watcher.target.executionId !== undefined) {
      // Pinned-execution watcher only matches that one execution. If the
      // caller does not know which execution this is, treat the watcher as a
      // non-match so we don't show an icon on a different execution row.
      return (
        execution.executionId !== undefined &&
        execution.executionId === watcher.target.executionId
      );
    }
    if (watcher.target.pipelineId !== undefined) {
      // No specific execution requested — match every execution of the
      // pinned pipeline in the target worktree. If the caller knows the
      // pipelineId for this row, require it to match.
      if (execution.pipelineId === undefined) return true;
      return execution.pipelineId === watcher.target.pipelineId;
    }
    // Whole-worktree pipeline watcher: matches every pipeline execution in
    // the worktree the watcher already targets.
    return true;
  });
}

export interface HookWatcherMatch {
  projectId: string;
  worktreeId: string;
  triggerName?: string;
  hookKey?: string;
  scope?: 'project' | 'workspace-root' | 'workspace-repo';
  repoId?: string;
}

export function watchersForHook(
  watchers: AppAdvisorWatcherSummary[],
  hook: HookWatcherMatch,
): AppAdvisorWatcherSummary[] {
  return visibleWatchers(watchers).filter((watcher) => {
    if (watcher.trigger !== 'worktree_hook_triggered') return false;
    if (watcher.target.kind !== 'worktree_hook') return false;
    if (watcher.target.projectId !== hook.projectId) return false;
    if (watcher.target.worktreeId !== hook.worktreeId) return false;
    if (
      hook.triggerName !== undefined &&
      watcher.target.triggerName !== hook.triggerName
    ) {
      return false;
    }
    if (watcher.target.hookKey !== undefined) {
      return (
        hook.hookKey !== undefined && watcher.target.hookKey === hook.hookKey
      );
    }
    if (watcher.target.scope !== undefined) {
      if (hook.scope === undefined || watcher.target.scope !== hook.scope) {
        return false;
      }
    }
    if (watcher.target.repoId !== undefined) {
      return hook.repoId !== undefined && watcher.target.repoId === hook.repoId;
    }
    return true;
  });
}

/**
 * Return the watchers owned by a subscribing chat. This is distinct from
 * "this chat is being watched": `destination` is the chat that receives the
 * watcher fire/delete notifications, while `target` is the thing being
 * watched.
 */
export function watchersForSubscriberDestination(
  watchers: AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): AppAdvisorWatcherSummary[] {
  return visibleWatchers(watchers).filter(
    (watcher) =>
      watcher.destination.projectId === destination.projectId &&
      watcher.destination.worktreeId === destination.worktreeId &&
      watcher.destination.chatId === destination.chatId,
  );
}

/**
 * Return the watchers that should light up on a chat surface. The watcher's
 * `target` (not its `destination`) decides whether a chat is being watched —
 * `destination` is the chat that *receives* the watcher fire message and is
 * intentionally not used here.
 *
 * The helper supports both worktree chats (the only place ChatPanel mounts a
 * watcher icon today) and standalone chats (so the Automations page and any
 * future surface can reuse the same filter). The `destination` parameter is
 * (re)used as the surface identity:
 *  - non-sentinel projectId / worktreeId / chatId → match `worktree_chat`.
 *  - {@link APP_ADVISOR_PROJECT_ID}/{@link APP_ADVISOR_WORKTREE_ID} sentinel
 *    destination → match App Advisor watchers.
 *  - any other projectId with no worktreeId → match `standalone_chat`.
 *
 * Renderer surfaces only need the `worktree_chat` variant; the other two
 * branches keep the helper future-proof for the Automations Watchers tab.
 */
export function watchersForChatDestination(
  watchers: AppAdvisorWatcherSummary[],
  destination: AppAdvisorWatcherDestination,
): AppAdvisorWatcherSummary[] {
  return visibleWatchers(watchers).filter((watcher) => {
    if (
      watcher.trigger === 'worktree_new_chat_started' &&
      watcher.target.kind === 'worktree_chat_scope'
    ) {
      return (
        watcher.target.projectId === destination.projectId &&
        watcher.target.worktreeId === destination.worktreeId
      );
    }
    if (
      watcher.trigger === 'standalone_new_chat_started' &&
      watcher.target.kind === 'standalone_chat_project'
    ) {
      return watcher.target.projectId === destination.projectId;
    }
    if (watcher.trigger !== 'worktree_chat_completion') {
      // Currently chat surfaces only host worktree_chat targets — the
      // standalone-chat branch keeps the structural test in place for the
      // Automations page, which can also match standalone targets.
      if (watcher.target.kind !== 'standalone_chat') return false;
    }
    if (watcher.target.kind === 'worktree_chat') {
      return (
        watcher.target.projectId === destination.projectId &&
        watcher.target.worktreeId === destination.worktreeId &&
        watcher.target.chatId === destination.chatId
      );
    }
    if (watcher.target.kind === 'standalone_chat') {
      return (
        watcher.target.projectId === destination.projectId &&
        watcher.target.chatId === destination.chatId
      );
    }
    return false;
  });
}
