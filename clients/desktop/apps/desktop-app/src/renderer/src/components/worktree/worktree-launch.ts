import type {
  ScriptRunResponse,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import {
  buildScriptEntries,
  findLaunchEntry,
  type ScriptEntry,
} from '@/components/activity/script-utils';
import type { AppliedProjectWorktreeScripts } from '@/lib/projectWorktreeScripts';
import {
  isScriptRunActive,
  useScriptsStore,
  type ScriptRunState,
} from '@/stores/scriptsStore';

/**
 * A worktree's Launch script, shared by both sidebar rails' Launch menu item:
 * the legacy row (through `WorktreeItemAdapter`) and the shared rail's host.
 */
export function resolveWorktreeLaunchEntry(
  project: SidebarItem,
  worktreeId: string,
  appliedProjectWorktreeScripts: AppliedProjectWorktreeScripts,
): ScriptEntry | undefined {
  return findLaunchEntry(
    buildScriptEntries(project, worktreeId, appliedProjectWorktreeScripts),
  );
}

/**
 * Whether the worktree's launch is already running, which disables Launch.
 * A workspace-level launch (`onRun`) owns every launch-lifecycle run; a
 * project script owns only its own run.
 */
export function isWorktreeLaunchActive(
  launchEntry: ScriptEntry | undefined,
  runs: Readonly<Record<string, ScriptRunState>> | undefined,
): boolean {
  if (!launchEntry || !runs) return false;
  if (launchEntry.onRun) {
    return Object.values(runs).some(
      (run) => run.lifecycle === 'launch' && isScriptRunActive(run.status),
    );
  }
  const existingRun = runs[launchEntry.script.scriptKey];
  return existingRun ? isScriptRunActive(existingRun.status) : false;
}

/** Start the worktree's launch script and record its run in the scripts store. */
export function runWorktreeLaunch(
  projectId: string,
  worktreeId: string,
  launchEntry: ScriptEntry,
): void {
  if (launchEntry.onRun) {
    void launchEntry.onRun().catch(() => undefined);
    return;
  }
  const request = launchEntry.request;
  if (!request) return;
  const scriptKey = launchEntry.script.scriptKey;
  useScriptsStore
    .getState()
    .startRun(projectId, worktreeId, launchEntry.script);
  void window.api
    .runScript(request)
    .then((response: ScriptRunResponse) => {
      useScriptsStore
        .getState()
        .completeRun(projectId, worktreeId, scriptKey, response);
    })
    .catch((cause: unknown) => {
      useScriptsStore.getState().completeRun(projectId, worktreeId, scriptKey, {
        success: false,
        exitCode: null,
        output:
          cause instanceof Error ? cause.message : 'Script execution failed',
        timedOut: false,
        durationMs: 0,
      });
    });
}

/**
 * Every active script run, keyed `worktreeKey` + NUL + `scriptKey`, valued by
 * its lifecycle. It carries no output, so a `useShallow` subscriber (the
 * shared rail's host) re-renders when a run starts or stops, never as it
 * prints.
 */
export function indexActiveScriptRuns(
  runs: Readonly<Record<string, Readonly<Record<string, ScriptRunState>>>>,
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [worktreeKey, worktreeRuns] of Object.entries(runs)) {
    for (const [scriptKey, run] of Object.entries(worktreeRuns)) {
      if (isScriptRunActive(run.status)) {
        index[`${worktreeKey}\u0000${scriptKey}`] = run.lifecycle;
      }
    }
  }
  return index;
}

/** {@link isWorktreeLaunchActive} over an {@link indexActiveScriptRuns} index. */
export function isWorktreeLaunchActiveInIndex(
  launchEntry: ScriptEntry | undefined,
  index: Readonly<Record<string, string>>,
  worktreeKey: string,
): boolean {
  if (!launchEntry) return false;
  const prefix = `${worktreeKey}\u0000`;
  if (launchEntry.onRun) {
    return Object.entries(index).some(
      ([key, lifecycle]) => key.startsWith(prefix) && lifecycle === 'launch',
    );
  }
  return `${prefix}${launchEntry.script.scriptKey}` in index;
}

/**
 * Worktree keys with an active run of `lifecycle`, read from an
 * {@link indexActiveScriptRuns} index.
 */
export function worktreesWithActiveRun(
  index: Readonly<Record<string, string>>,
  lifecycle: ScriptRunState['lifecycle'],
): Set<string> {
  const keys = new Set<string>();
  for (const [key, runLifecycle] of Object.entries(index)) {
    if (runLifecycle !== lifecycle) continue;
    keys.add(key.slice(0, key.indexOf('\u0000')));
  }
  return keys;
}
