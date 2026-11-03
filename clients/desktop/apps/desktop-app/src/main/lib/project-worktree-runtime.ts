import {
  withWorkspaceTargetRuntimePreparation,
  assertWorkspaceTargetRuntimeStartAllowed,
} from './workspace-target-exclusion';
import type { SingleRepoSidebarItem } from '@canopy/desktop-shared/types';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { readPreferencesFile } from '../lib/preferences-store';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import { scheduleCodeGraphBuild } from './code-graph-scheduler';
import type { ScriptRunLogRef } from './script-log-store';
import { getWorktreeDir } from './paths';
import { runDesktopScript } from './script-execution';
import {
  createProjectScriptDescriptor,
  createScriptCompleteEvent,
  createScriptOutputEvent,
  createScriptStartedEvent,
} from './script-events';
import {
  getResolvedScriptDefinition,
  resolveProjectScripts,
} from './script-resolver';
import { sendToWindow } from './window-send';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  resolveEffectiveScriptTimeoutSeconds,
} from '@canopy/desktop-shared/scripts';
import {
  getWorkspaceWorktreeCreatedAt,
  isWorkspaceWorktreeCurrent,
} from './workspace-persistence';
import {
  buildWorktreeSetupScriptResult,
  notifyWorktreeSetupObserver,
  type WorktreeSetupObserver,
  type WorktreeSetupScriptRef,
  type WorktreeSetupScriptResult,
} from './worktree-setup-result';

/**
 * Outcome of running a project worktree's post-create setup script to
 * completion. `skipped` means no setup script is configured; `completed` means
 * the setup script exited 0; `failed` means it exited non-zero, timed out, or
 * threw. `detail` carries a short human-readable reason for `failed`.
 * `script` identifies the started setup run (run ID, canonical log ref, real
 * exit code); it is absent when no script started.
 */
export interface ProjectWorktreeSetupResult {
  status: 'completed' | 'failed' | 'skipped';
  detail?: string;
  script?: WorktreeSetupScriptResult;
}

export function startProjectWorktreePostCreateSetup(params: {
  projectId: string;
  worktreeId: string;
  project: Pick<SingleRepoSidebarItem, 'repoPath' | 'scripts'>;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  // The normal UI path does not surface completion; the renderer follows
  // progress via the streamed script events. The promise lets callers track it.
  return runProjectWorktreePostCreateSetup(params).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Run a project worktree's post-create setup script to completion and return a
 * structured result. This is the awaitable core shared by the fire-and-forget
 * UI path (`startProjectWorktreePostCreateSetup`) and callers that must block
 * until setup finishes (e.g. Split PR carving each child in a set-up worktree).
 *
 * Behavior is identical to the historic fire-and-forget flow — same script
 * resolution, same streamed `scriptStarted`/`scriptOutput`/`scriptComplete`
 * events, same log persistence, same timeout policy, and a trailing discovery
 * trigger — with two additions: it resolves with a `ProjectWorktreeSetupResult`
 * and it honors an optional `signal` so a caller can abort the running script
 * (the underlying `runShellScript` kills the process group on abort).
 *
 * An optional `observer` receives resolution, start and completion events
 * (see `WorktreeSetupObserver`); observer failures never affect setup.
 */
export async function runProjectWorktreePostCreateSetup(
  params: Parameters<typeof runProjectWorktreePostCreateSetupOwned>[0],
): Promise<ProjectWorktreeSetupResult> {
  return withWorkspaceTargetRuntimePreparation(
    params.projectId,
    params.worktreeId,
    () => runProjectWorktreePostCreateSetupOwned(params),
  );
}

async function runProjectWorktreePostCreateSetupOwned(params: {
  projectId: string;
  worktreeId: string;
  project: Pick<SingleRepoSidebarItem, 'repoPath' | 'scripts'>;
  getWindow: () => BrowserWindow | null;
  signal?: AbortSignal;
  observer?: WorktreeSetupObserver;
}): Promise<ProjectWorktreeSetupResult> {
  const worktreePath = getWorktreeDir(params.projectId, params.worktreeId);
  const setupStartedCreatedAt = await getWorkspaceWorktreeCreatedAt(
    params.projectId,
    params.worktreeId,
  ).catch(() => null);
  let setupScript: ReturnType<typeof createProjectScriptDescriptor> | null =
    null;
  let setupScriptLogRef: ScriptRunLogRef | null = null;
  const runId: string = randomUUID();
  let startedScript: WorktreeSetupScriptRef | null = null;
  let completedScript: WorktreeSetupScriptResult | null = null;
  const observer = params.observer;

  try {
    const resolvedScripts = await resolveProjectScripts(
      params.project,
      worktreePath,
    );
    const definition = getResolvedScriptDefinition(resolvedScripts, 'setup');
    notifyWorktreeSetupObserver('resolved', () =>
      observer?.onResolved?.(definition !== undefined),
    );
    if (!definition) {
      return { status: 'skipped' };
    }
    const command = definition.command;

    const setupScriptDescriptor = createProjectScriptDescriptor(
      'setup',
      command,
      definition.devServerPattern,
      definition.shell,
      definition.interactive,
    );
    setupScript = setupScriptDescriptor;
    assertWorkspaceTargetRuntimeStartAllowed(
      params.projectId,
      params.worktreeId,
    );
    // The worker writes the run log under this run id.
    setupScriptLogRef = {
      projectId: params.projectId,
      worktreeId: params.worktreeId,
      script: setupScriptDescriptor,
      runId,
    };
    const scriptRef: WorktreeSetupScriptRef = {
      scriptKey: setupScriptDescriptor.scriptKey,
      runId,
      target: 'project',
      lifecycle: 'setup',
      logRef: setupScriptLogRef,
    };
    startedScript = scriptRef;
    notifyWorktreeSetupObserver('script-started', () =>
      observer?.onScriptStarted?.(scriptRef),
    );
    const prefs = await readPreferencesFile().catch(() => null);
    const startedWindow = params.getWindow();
    if (startedWindow) {
      sendToWindow(
        startedWindow,
        IPC_CHANNELS.scriptStarted,
        createScriptStartedEvent(
          params.projectId,
          params.worktreeId,
          setupScriptDescriptor,
          'automatic-setup',
          runId,
        ),
      );
    }

    const onLines = (lines: string[]): void => {
      const window = params.getWindow();
      if (!window) {
        return;
      }

      sendToWindow(
        window,
        IPC_CHANNELS.scriptOutput,
        createScriptOutputEvent(
          params.projectId,
          params.worktreeId,
          setupScriptDescriptor,
          'automatic-setup',
          lines,
          runId,
        ),
      );
    };

    const { response: result } = await runDesktopScript(
      {
        projectId: params.projectId,
        worktreeId: params.worktreeId,
        context: { kind: 'project' },
        script: setupScriptDescriptor,
        invocation: 'automatic-setup',
        command,
        ...(definition.shell ? { shell: definition.shell } : {}),
        timeoutSeconds:
          definition.interactive === true
            ? null
            : resolveEffectiveScriptTimeoutSeconds({
                scriptName: 'setup',
                configuredTimeoutSeconds: definition.timeoutSeconds,
                defaultTimeoutSeconds:
                  prefs?.scriptTimeoutMinutes !== undefined
                    ? prefs.scriptTimeoutMinutes * 60
                    : DEFAULT_SCRIPT_TIMEOUT_SECONDS,
              }),
        interactive: definition.interactive === true,
        backgroundPriority: true,
        runId,
      },
      {
        ...(params.signal ? { signal: params.signal } : {}),
        observer: { onLines },
      },
    );

    const scriptResult = buildWorktreeSetupScriptResult(scriptRef, result);
    // Cleared so a throw from the completion broadcast below cannot report
    // this run a second time from the catch branch.
    startedScript = null;
    completedScript = scriptResult;
    notifyWorktreeSetupObserver('script-completed', () =>
      observer?.onScriptCompleted?.(scriptResult),
    );

    const window = params.getWindow();
    if (window) {
      sendToWindow(
        window,
        IPC_CHANNELS.scriptComplete,
        createScriptCompleteEvent(
          params.projectId,
          params.worktreeId,
          setupScriptDescriptor,
          'automatic-setup',
          result,
          runId,
        ),
      );
    }

    if (result.success) {
      return { status: 'completed', script: scriptResult };
    }
    const detail = result.timedOut
      ? 'setup script timed out'
      : `setup script exited with code ${result.exitCode ?? 'null'}`;
    return { status: 'failed', detail, script: scriptResult };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (completedScript) {
      // A throw after completion (the broadcast) keeps the real run: its
      // canonical log is not rewritten and the result the observer saw stands.
      return { status: 'failed', detail, script: completedScript };
    }
    const failureResult = {
      success: false,
      exitCode: 1,
      output: detail,
      timedOut: false,
      durationMs: 0,
    };

    // The worker closed the run log of any run it started.
    const failedRef = startedScript;
    const scriptResult = failedRef
      ? buildWorktreeSetupScriptResult(failedRef, failureResult)
      : undefined;
    if (scriptResult) {
      notifyWorktreeSetupObserver('script-completed', () =>
        observer?.onScriptCompleted?.(scriptResult),
      );
    }

    const window = params.getWindow();
    if (window && setupScript) {
      sendToWindow(
        window,
        IPC_CHANNELS.scriptComplete,
        createScriptCompleteEvent(
          params.projectId,
          params.worktreeId,
          setupScript,
          'automatic-setup',
          failureResult,
          runId,
        ),
      );
    }

    return scriptResult
      ? { status: 'failed', detail: failureResult.output, script: scriptResult }
      : { status: 'failed', detail: failureResult.output };
  } finally {
    let runtimeStartAllowed = false;
    try {
      assertWorkspaceTargetRuntimeStartAllowed(
        params.projectId,
        params.worktreeId,
      );
      runtimeStartAllowed = true;
    } catch {
      // Archive teardown invalidates the setup preparation token. Its
      // finalizer must not restart readers after cancellation.
    }
    if (
      runtimeStartAllowed &&
      setupStartedCreatedAt !== null &&
      (await isWorkspaceWorktreeCurrent(
        params.projectId,
        params.worktreeId,
        setupStartedCreatedAt,
      ).catch(() => false))
    ) {
      triggerDiscovery(params.projectId, params.worktreeId, params.getWindow);
      scheduleCodeGraphBuild({
        projectId: params.projectId,
        worktreeId: params.worktreeId,
        reason: 'worktree-created',
      });
    }
  }
}
