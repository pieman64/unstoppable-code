import { useEffect, useMemo } from 'react';
import { createScriptDevServerAutoOpener } from '@/lib/scriptDevServerAutoOpen';
import { isBrowserOpenTargetAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { useScriptsStore } from '@/stores/scriptsStore';
import { useGitHubStore } from '@/stores/githubStore';
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
      },
    );
    return unsubscribe;
  }, [startRunFromEvent, autoOpener]);

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
        autoOpener.completed(event);
        useScriptsStore.getState().completeRunFromEvent(event);
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
        if (shouldToastAfterScriptCompleteFailure(event)) {
          const worktreeKey = `${event.projectId}/${event.worktreeId}`;
          const isTearingDown = useProjectsStore
            .getState()
            .tearingDownWorktrees.has(worktreeKey);
          if (isTearingDown) {
            return;
          }
          const prefix = event.script.label;
          const reason = event.result.timedOut
            ? `${prefix} timed out`
            : `${prefix} failed — exit ${event.result.exitCode ?? 'unknown'}`;
          const project = useProjectsStore
            .getState()
            .projects.find((p) => p.id === event.projectId);
          useGitHubStore.getState().addToast(reason, 'error', undefined, {
            category: 'Script',
            workspaceName: project?.name,
            projectId: event.projectId,
            worktreeId: event.worktreeId,
          });
        }
      },
    );
    return unsubscribe;
  }, [autoOpener]);
}
