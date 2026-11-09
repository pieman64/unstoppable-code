import { useEffect, useMemo, useState } from 'react';
import { createScriptDevServerAutoOpener } from '@/lib/scriptDevServerAutoOpen';
import { summarizeScriptFailure } from '@/lib/scriptFailureSummary';
import { openScriptFailureOutput } from '@/stores/scriptFailureOutputStore';
import { isBrowserOpenTargetAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { useScriptsStore } from '@/stores/scriptsStore';
import { addFailureToast, clearFailureToast } from '@/stores/toastStore';
import { worktreeToastOrigin } from '@/lib/toastWorktreeNavigation';
import { ownWorkToastError } from '@canopy/ui-shared/lib';
import { useProjectsStore } from '@/stores/projectsStore';
import { useChatStore } from '@/stores/chatStore';
import { useFileListStore } from '@/stores/fileListStore';
import { shouldRefreshDiscoveryAfterScriptLifecycle } from '@canopy/desktop-shared/scripts';
import {
  ensureTerminalWorktreeHydrated,
  selectBucket,
  useTerminalStore,
} from '@/stores/terminalStore';
import { ensureTerminalPanelVisible } from '@/lib/panels/terminal-panel-activation';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import type {
  ScriptCompleteEvent,
  ScriptOutputEvent,
  ScriptStartedEvent,
} from '@canopy/desktop-shared/types';

/**
 * Whether a {@link ScriptCompleteEvent} should invalidate the cached file
 * index/tree for the script's worktree. We invalidate on **any** successful
 * script (even ones whose lifecycle does not gate discovery refresh) since
 * a successful `run` or setup script may have written new files. Failed
 * scripts do not invalidate — matching the discovery-refresh gate's
 * existing skip-on-failure behavior so we don't churn caches when nothing
 * changed.
 */
export function shouldInvalidateFileCacheAfterScriptComplete(
  event: ScriptCompleteEvent,
): boolean {
  return event.result.success;
}

export function shouldToastAfterScriptCompleteFailure(
  event: ScriptCompleteEvent,
): boolean {
  return (
    !event.result.success &&
    (event.result.timedOut || event.result.exitCode !== null)
  );
}

// Names who owns the failed command without claiming its cause: a timeout or
// spawn failure doesn't prove the repository is at fault, so this only says
// where the script comes from. The message also reaches toast details and OS
// notifications, which don't show the toast's category.
const SCRIPT_FAILURE_ATTRIBUTION = 'This is a script from your repository.';

/**
 * The failure toast's message: the script, then the output line that says
 * why, then where the script comes from.
 */
export function buildScriptFailureToastMessage(
  event: ScriptCompleteEvent,
  outputLines: readonly string[],
): string {
  const summary = describeScriptFailure(event, outputLines).trimEnd();
  const separator = /[.!?…]$/.test(summary) ? ' ' : '. ';
  return `${summary}${separator}${SCRIPT_FAILURE_ATTRIBUTION}`;
}

function describeScriptFailure(
  event: ScriptCompleteEvent,
  outputLines: readonly string[],
): string {
  const label = event.script.label;
  if (event.result.timedOut) return `${label} timed out`;
  const reason = summarizeScriptFailure(outputLines);
  return reason === null ? `${label} failed` : `${label} failed: ${reason}`;
}

/** One script's visible failure in one worktree. */
function scriptFailureToastKey(event: ScriptStartedEvent): string {
  return `script:${event.projectId}/${event.worktreeId}/${event.script.scriptKey}`;
}

/**
 * Whether this completion is the script's latest start. Only then can it speak
 * for the script: an older run's success must not clear a newer run's failure.
 * A run without a run ID can't be told apart, so it never qualifies.
 */
function isLatestScriptRun(
  latestRuns: ReadonlyMap<string, string>,
  event: ScriptCompleteEvent,
): boolean {
  return (
    event.runId !== undefined &&
    latestRuns.get(scriptFailureToastKey(event)) === event.runId
  );
}

export function useScriptEventSubscriptions(): void {
  const autoOpener = useMemo(
    () =>
      createScriptDevServerAutoOpener((hit, context) => {
        // Script output also reaches a window that shows another computer,
        // which can open neither target: open nothing there.
        if (!isBrowserOpenTargetAvailable(hit.openTarget)) return;
        void import('@/components/activity/devServerOpen')
          .then(({ autoOpenDevServerHit }) =>
            autoOpenDevServerHit(hit, context),
          )
          .catch(() => undefined);
      }),
    [],
  );
  const appendOutput = useScriptsStore((state) => state.appendOutput);
  const startRunFromEvent = useScriptsStore((state) => state.startRunFromEvent);
  const [latestRuns] = useState(() => new Map<string, string>());

  useEffect(() => {
    return window.api.terminal.onSpawned((session) => {
      if (session.kind !== 'script') return;
      void ensureTerminalWorktreeHydrated(session.projectId, session.worktreeId)
        .then(() => {
          const terminalState = useTerminalStore.getState();
          const bucket = selectBucket(
            terminalState,
            session.projectId,
            session.worktreeId,
          );
          if (bucket?.sessions[session.id] === undefined) {
            terminalState.addGroupWithTerminal(session, {
              activate: session.focusOnSpawn === true,
            });
          }
          ensureTerminalPanelVisible(
            makeWorktreePanelKey(session.projectId, session.worktreeId),
            undefined,
            {
              terminalId: session.id,
              title: session.title ?? 'Terminal',
              focus: session.focusOnSpawn === true,
              ...(session.focusOnSpawn === true
                ? { focusOwnerDocument: document }
                : {}),
            },
          );
        })
        .catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.onScriptStarted(
      (event: ScriptStartedEvent) => {
        autoOpener.started(event);
        startRunFromEvent(event);
        const key = scriptFailureToastKey(event);
        if (event.runId === undefined) latestRuns.delete(key);
        else latestRuns.set(key, event.runId);
      },
    );
    return unsubscribe;
  }, [startRunFromEvent, autoOpener, latestRuns]);

  useEffect(() => {
    const unsubscribe = window.api.onScriptOutput(
      (event: ScriptOutputEvent) => {
        appendOutput(event);
        autoOpener.output(event);
      },
    );
    return unsubscribe;
  }, [appendOutput, autoOpener]);

  useEffect(() => {
    const unsubscribe = window.api.onScriptComplete(
      (event: ScriptCompleteEvent) => {
        const accepted = useScriptsStore.getState().completeRunFromEvent(event);
        if (accepted) autoOpener.completed(event);
        if (event.result.success && isLatestScriptRun(latestRuns, event)) {
          clearFailureToast(scriptFailureToastKey(event));
        }
        if (shouldInvalidateFileCacheAfterScriptComplete(event)) {
          // Any successful script may have written files into the
          // worktree, so drop cached file index/tree state for that
          // worktree. This is independent of the discovery refresh
          // gate — file caches must invalidate even for lifecycles
          // that do not trigger discovery (e.g. plain `run` scripts).
          useFileListStore
            .getState()
            .invalidate(event.projectId, event.worktreeId);
          if (
            shouldRefreshDiscoveryAfterScriptLifecycle(event.script.lifecycle)
          ) {
            useChatStore
              .getState()
              .queueWorktreeTabDiscoveryRefresh(
                event.projectId,
                event.worktreeId,
              );
          }
        }
        if (accepted && shouldToastAfterScriptCompleteFailure(event)) {
          const worktreeKey = `${event.projectId}/${event.worktreeId}`;
          const isTearingDown = useProjectsStore
            .getState()
            .tearingDownWorktrees.has(worktreeKey);
          if (
            isTearingDown ||
            !useScriptsStore.getState().claimFailureNotification(event)
          ) {
            return;
          }
          // The store keeps the output's tail, where errors print; the event's
          // output keeps its head. The store has no lines for a worktree whose
          // Activity panel never loaded.
          const storedLines =
            useScriptsStore.getState().runs[worktreeKey]?.[
              event.script.scriptKey
            ]?.outputLines ?? [];
          const outputLines =
            storedLines.length > 0
              ? storedLines
              : event.result.output.split(/\r?\n/);
          const project = useProjectsStore
            .getState()
            .projects.find((p) => p.id === event.projectId);
          const message = buildScriptFailureToastMessage(event, outputLines);
          addFailureToast({
            message,
            error: ownWorkToastError(message),
            origin: worktreeToastOrigin(event.projectId, event.worktreeId),
            ...(isLatestScriptRun(latestRuns, event)
              ? { key: scriptFailureToastKey(event) }
              : {}),
            meta: {
              category: 'Script',
              messageContext: SCRIPT_FAILURE_ATTRIBUTION,
              workspaceName: project?.name,
              projectId: event.projectId,
              worktreeId: event.worktreeId,
              action: {
                label: 'View output',
                onClick: (): void =>
                  openScriptFailureOutput({
                    label: event.script.label,
                    status: 'failed',
                    outputLines,
                    exitCode: event.result.exitCode,
                    timedOut: event.result.timedOut,
                    durationMs: event.result.durationMs,
                  }),
              },
            },
          });
        }
      },
    );
    return unsubscribe;
  }, [autoOpener, latestRuns]);
}
