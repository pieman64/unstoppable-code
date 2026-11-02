import type { ChatTabsFile } from '@canopy/desktop-shared/types';
import type { ChatTabsWriteDelta, ChatTabsWriteObserver } from './chat-tabs';

/**
 * Settles once the projection has landed, or was superseded by a newer one;
 * a rejection retains the step for retry. `void` is a synchronous step.
 */
type ProjectionResult = void | Promise<void>;

export interface ChatTabsAuxiliaryProjectionSteps {
  /** `isCurrent` turns false once a newer commit for the scope is published. */
  indexSearch(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
    isCurrent: (() => boolean) | undefined,
  ): ProjectionResult;
  syncBadges(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): ProjectionResult;
  syncWorkEntrySummary(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    isCurrent: (() => boolean) | undefined,
  ): Promise<void>;
  /** Runtime-status activity, stamped once per projected commit. */
  publishRuntimeStatus(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
  ): void;
  /** Portal and sidebar projections of the same snapshot. */
  publishScope(
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
  ): ProjectionResult;
  /** Sidebar re-list once a retried Work Entry summary lands. */
  nudgeSummary(projectId: string, worktreeId: string): void;
  logRetry(message: string, error: unknown): void;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
}

type DetachedStep = 'search' | 'badges' | 'scope';

const DETACHED_STEP_LABELS: Record<DetachedStep, string> = {
  search: 'Chat search',
  badges: 'Chat badge',
  scope: 'Portal',
};

const NO_TAB_CHANGES: ChatTabsWriteDelta = {
  changedTabIds: [],
  removedTabIds: [],
};

interface SummaryRetry {
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface DetachedStepRetry {
  failures: number;
  /** A failed run projected the whole scope, so the next run does too. */
  full: boolean;
  /** Tabs failed runs did not project; the next run folds them in. */
  tabIds: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

interface ProjectionScope {
  projectId: string;
  worktreeId: string;
  /**
   * The newest snapshot the observer received, which retries project. Held
   * only while a step runs or a retry is scheduled.
   */
  latest?: { data: ChatTabsFile; isCurrent: (() => boolean) | undefined };
  running: number;
  retries: Map<DetachedStep, DetachedStepRetry>;
  /**
   * Failures counted per step. Runs overlapping one counted failure, such as
   * commits coalesced into one search update, count once; an error's identity
   * cannot tell attempts apart, since a failed worker reuses its error.
   */
  countedFailures: Map<DetachedStep, number>;
}

const retryDelayMs = (failures: number): number =>
  Math.min(100 * 2 ** Math.min(failures - 1, 9), 30_000);

/**
 * Retained tabs resolve against the newest snapshot: a tab still present is
 * re-projected from it, a missing one is removed.
 */
function foldRetainedTabs(
  data: ChatTabsFile,
  retained: ReadonlySet<string>,
  delta: ChatTabsWriteDelta,
): ChatTabsWriteDelta {
  const changed = new Set(delta.changedTabIds);
  const removed = new Set(delta.removedTabIds);
  const present = new Set(data.tabs.map((tab) => tab.id));
  for (const id of Array.from(retained)) {
    if (changed.has(id) || removed.has(id)) continue;
    if (present.has(id)) changed.add(id);
    else removed.add(id);
  }
  return {
    changedTabIds: Array.from(changed),
    removedTabIds: Array.from(removed),
  };
}

/**
 * Builds the post-commit auxiliary projection observer. Each commit starts
 * search and badges, awaits the Work Entry summary, then stamps runtime
 * status and starts the Portal and sidebar projections.
 *
 * Search, badges and Portal settle after the observer returns, so the drain
 * never holds a scope behind their debounce or throttle. Each reports back
 * here: a failed step keeps its tabs and retries alone with capped backoff
 * against the newest snapshot, or folds into the scope's next commit sooner.
 * Rerunning the whole observer would re-stamp runtime-status activity for an
 * already-published commit. A retry waits while its snapshot is not current;
 * the newer projection, or the startup rebuild after a deletion, owns it then.
 *
 * A failed summary does not hold back publication and retries on its own; a
 * successful retry only nudges the sidebar to re-list. Each scope keeps one
 * summary retry, replaced by its next commit and dropped once the snapshot is
 * not current.
 */
export function createChatTabsAuxiliaryProjectionObserver(
  steps: ChatTabsAuxiliaryProjectionSteps,
): ChatTabsWriteObserver {
  const schedule =
    steps.schedule ??
    ((callback: () => void, delayMs: number): ReturnType<typeof setTimeout> =>
      setTimeout(callback, delayMs));
  const summaryRetries = new Map<string, SummaryRetry>();
  const scopes = new Map<string, ProjectionScope>();

  const invokeDetachedStep = (
    step: DetachedStep,
    scope: ProjectionScope,
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
    isCurrent: (() => boolean) | undefined,
  ): ProjectionResult => {
    switch (step) {
      case 'search':
        return steps.indexSearch(
          scope.projectId,
          scope.worktreeId,
          data,
          delta,
          isCurrent,
        );
      case 'badges':
        return steps.syncBadges(scope.projectId, scope.worktreeId, data);
      case 'scope':
        return steps.publishScope(
          scope.projectId,
          scope.worktreeId,
          data,
          delta,
        );
    }
  };

  const releaseScope = (key: string, scope: ProjectionScope): void => {
    if (scope.running > 0) return;
    for (const retry of Array.from(scope.retries.values())) {
      if (retry.timer) return;
    }
    scope.latest = undefined;
    if (scope.retries.size === 0 && scopes.get(key) === scope) {
      scopes.delete(key);
    }
  };

  const settleDetachedStep = (
    key: string,
    scope: ProjectionScope,
    step: DetachedStep,
    failure:
      | {
          error: unknown;
          delta: ChatTabsWriteDelta | undefined;
          countedAtStart: number;
        }
      | undefined,
  ): void => {
    scope.running -= 1;
    const retry = scope.retries.get(step);
    if (!failure) {
      if (retry && !retry.timer && !retry.full && retry.tabIds.size === 0) {
        scope.retries.delete(step);
      }
      releaseScope(key, scope);
      return;
    }
    const next = retry ?? { failures: 0, full: false, tabIds: new Set() };
    scope.retries.set(step, next);
    if (failure.delta) {
      failure.delta.changedTabIds.forEach((id) => next.tabIds.add(id));
      failure.delta.removedTabIds.forEach((id) => next.tabIds.add(id));
    } else {
      next.full = true;
    }
    const counted = scope.countedFailures.get(step) ?? 0;
    if (next.failures === 0 || counted === failure.countedAtStart) {
      scope.countedFailures.set(step, counted + 1);
      next.failures += 1;
      steps.logRetry(
        `[chat-state] ${DETACHED_STEP_LABELS[step]} projection failed (attempt ${next.failures}); retry scheduled:`,
        failure.error,
      );
    }
    if (!next.timer) {
      const timer = schedule(() => {
        if (next.timer !== timer) return;
        next.timer = undefined;
        const latest = scope.latest;
        if (!latest || latest.isCurrent?.() === false) {
          releaseScope(key, scope);
          return;
        }
        runDetachedStep(
          key,
          scope,
          step,
          latest.data,
          NO_TAB_CHANGES,
          latest.isCurrent,
        );
      }, retryDelayMs(next.failures));
      timer.unref?.();
      next.timer = timer;
    }
    releaseScope(key, scope);
  };

  const runDetachedStep = (
    key: string,
    scope: ProjectionScope,
    step: DetachedStep,
    data: ChatTabsFile,
    delta: ChatTabsWriteDelta | undefined,
    isCurrent: (() => boolean) | undefined,
  ): void => {
    const retry = scope.retries.get(step);
    let runDelta = delta;
    if (retry) {
      if (retry.timer) {
        clearTimeout(retry.timer);
        retry.timer = undefined;
      }
      runDelta =
        retry.full || !delta
          ? undefined
          : foldRetainedTabs(data, retry.tabIds, delta);
      retry.full = false;
      retry.tabIds.clear();
    }
    scope.running += 1;
    const countedAtStart = scope.countedFailures.get(step) ?? 0;
    // Starts the step synchronously; a synchronous throw rejects `result`.
    const result = (async (): Promise<void> => {
      await invokeDetachedStep(step, scope, data, runDelta, isCurrent);
    })();
    void result.then(
      () => settleDetachedStep(key, scope, step, undefined),
      (error: unknown) =>
        settleDetachedStep(key, scope, step, {
          error,
          delta: runDelta,
          countedAtStart,
        }),
    );
  };

  const syncSummary = async (
    key: string,
    projectId: string,
    worktreeId: string,
    data: ChatTabsFile,
    isCurrent: (() => boolean) | undefined,
    retried: boolean,
  ): Promise<void> => {
    const retry = summaryRetries.get(key);
    if (retry?.timer) {
      clearTimeout(retry.timer);
      retry.timer = undefined;
    }
    try {
      await steps.syncWorkEntrySummary(projectId, worktreeId, data, isCurrent);
    } catch (error) {
      if (isCurrent?.() === false) return;
      const next = summaryRetries.get(key) ?? { failures: 0 };
      if (next.timer) return;
      next.failures += 1;
      const timer = schedule(() => {
        if (next.timer !== timer) return;
        next.timer = undefined;
        if (isCurrent?.() === false) {
          if (summaryRetries.get(key) === next) summaryRetries.delete(key);
          return;
        }
        void syncSummary(key, projectId, worktreeId, data, isCurrent, true);
      }, retryDelayMs(next.failures));
      timer.unref?.();
      next.timer = timer;
      summaryRetries.set(key, next);
      steps.logRetry(
        `[chat-state] Work Entry summary failed (attempt ${next.failures}); retry scheduled:`,
        error,
      );
      return;
    }
    if (isCurrent?.() === false) return;
    // A newer attempt's pending retry still owns the scope.
    if (summaryRetries.get(key)?.timer) return;
    summaryRetries.delete(key);
    // The commit's publishScope ran while this summary was failing.
    if (retried) steps.nudgeSummary(projectId, worktreeId);
  };

  return async (projectId, worktreeId, data, delta, _revision, isCurrent) => {
    if (isCurrent?.() === false) return;
    const key = `${projectId}\u0000${worktreeId}`;
    let scope = scopes.get(key);
    if (!scope) {
      scope = {
        projectId,
        worktreeId,
        running: 0,
        retries: new Map(),
        countedFailures: new Map(),
      };
      scopes.set(key, scope);
    }
    scope.latest = { data, isCurrent };
    // The observer itself holds the scope so a step settling early cannot
    // release it before the Portal projection starts.
    scope.running += 1;
    try {
      runDetachedStep(key, scope, 'search', data, delta, isCurrent);
      runDetachedStep(key, scope, 'badges', data, delta, isCurrent);
      await syncSummary(key, projectId, worktreeId, data, isCurrent, false);
      // A newer commit's projection inherits this delta and runs the summary.
      if (isCurrent?.() === false) return;
      steps.publishRuntimeStatus(projectId, worktreeId, data);
      runDetachedStep(key, scope, 'scope', data, delta, isCurrent);
    } finally {
      scope.running -= 1;
      releaseScope(key, scope);
    }
  };
}
