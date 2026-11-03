import {
  withWorkspaceTargetRuntimePreparation,
  assertWorkspaceTargetRuntimeStartAllowed,
} from './workspace-target-exclusion';
import { mkdir, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type ScriptRunResponse,
  type WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import { scheduleCodeGraphBuild } from './code-graph-scheduler';
import { getCurrentBranch } from './git';
import {
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeReposDir,
} from './paths';
import { runDesktopScript } from './script-execution';
import type { WorkerScriptContext } from '@canopy/protocol/canopy-core';
import {
  createScriptCompleteEvent,
  createScriptOutputEvent,
  createScriptStartedEvent,
  createWorkspaceRepoScriptDescriptor,
  createWorkspaceRootScriptDescriptor,
} from './script-events';
import { sendToWindow } from './window-send';
import {
  getResolvedScriptDefinition,
  resolveWorkspaceRepoScripts,
  resolveWorkspaceRootScripts,
} from './script-resolver';
import {
  createScriptKey,
  resolveEffectiveScriptTimeoutSeconds,
  type CommandShellDefinition,
  type ScriptDevServerPattern,
} from '@canopy/desktop-shared/scripts';
import { readPreferencesFile } from '../lib/preferences-store';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import {
  getWorkspaceWorktreeCreatedAt,
  isWorkspaceWorktreeCurrent,
  readWorkspaceConfig,
} from './workspace-persistence';
import {
  buildWorktreeSetupScriptResult,
  getWorktreeSetupRunStatus,
  notifyWorktreeSetupObserver,
  type WorktreeSetupLifecycle,
  type WorktreeSetupObserver,
  type WorktreeSetupRunResult,
  type WorktreeSetupScriptRef,
  type WorktreeSetupScriptResult,
} from './worktree-setup-result';

type WorkspaceRuntimeScriptDescriptor = ReturnType<
  | typeof createWorkspaceRootScriptDescriptor
  | typeof createWorkspaceRepoScriptDescriptor
>;

type WorkspaceRuntimeScriptKind = 'workspace-lifecycle' | 'automatic-setup';

/**
 * Per-run observer state. `onResolved` fires at most once per setup run and
 * `onScriptCompleted` at most once per script run.
 */
interface WorkspaceSetupRunTracker {
  observer?: WorktreeSetupObserver;
  resolved: boolean;
  /** Results already reported to the observer, by run ID. */
  completed: Map<string, WorktreeSetupScriptResult>;
}

function markSetupResolved(
  tracker: WorkspaceSetupRunTracker | undefined,
  configured: boolean,
): void {
  if (!tracker || tracker.resolved) {
    return;
  }
  tracker.resolved = true;
  const observer = tracker.observer;
  notifyWorktreeSetupObserver('resolved', () =>
    observer?.onResolved?.(configured),
  );
}

function notifySetupScriptCompleted(
  tracker: WorkspaceSetupRunTracker | undefined,
  result: WorktreeSetupScriptResult,
): void {
  if (!tracker || tracker.completed.has(result.runId)) {
    return;
  }
  tracker.completed.set(result.runId, result);
  const observer = tracker.observer;
  notifyWorktreeSetupObserver('script-completed', () =>
    observer?.onScriptCompleted?.(result),
  );
}

async function canStartPostSetupWork(
  workspaceId: string,
  worktreeId: string,
  createdAt: string | null,
): Promise<boolean> {
  if (
    !createdAt ||
    !(await isWorkspaceWorktreeCurrent(
      workspaceId,
      worktreeId,
      createdAt,
    ).catch(() => false))
  ) {
    return false;
  }
  try {
    assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId);
    return true;
  } catch {
    return false;
  }
}

function emitScriptStarted(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
  worktreeId: string,
  script: WorkspaceRuntimeScriptDescriptor,
  kind: WorkspaceRuntimeScriptKind,
  runId: string,
): void {
  const window = getWindow();
  if (!window) {
    return;
  }

  sendToWindow(
    window,
    IPC_CHANNELS.scriptStarted,
    createScriptStartedEvent(workspaceId, worktreeId, script, kind, runId),
  );
}

function emitScriptOutput(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
  worktreeId: string,
  script: WorkspaceRuntimeScriptDescriptor,
  kind: WorkspaceRuntimeScriptKind,
  lines: string[],
  runId: string,
): void {
  const window = getWindow();
  if (!window) {
    return;
  }

  sendToWindow(
    window,
    IPC_CHANNELS.scriptOutput,
    createScriptOutputEvent(
      workspaceId,
      worktreeId,
      script,
      kind,
      lines,
      runId,
    ),
  );
}

function emitScriptComplete(
  getWindow: () => BrowserWindow | null,
  workspaceId: string,
  worktreeId: string,
  script: WorkspaceRuntimeScriptDescriptor,
  kind: WorkspaceRuntimeScriptKind,
  result: ScriptRunResponse,
  runId: string,
): void {
  const window = getWindow();
  if (!window) {
    return;
  }

  sendToWindow(
    window,
    IPC_CHANNELS.scriptComplete,
    createScriptCompleteEvent(
      workspaceId,
      worktreeId,
      script,
      kind,
      result,
      runId,
    ),
  );
}

async function runWorkspaceRuntimeScript({
  workspaceId,
  worktreeId,
  script,
  command,
  shell,
  context,
  timeoutSeconds,
  getWindow,
  kind,
  interactive,
  lifecycle,
  tracker,
  onStarted,
}: {
  workspaceId: string;
  worktreeId: string;
  script: WorkspaceRuntimeScriptDescriptor;
  command: string;
  shell?: CommandShellDefinition;
  /** The checkout the worker runs it in, with the worktree's environment. */
  context: WorkerScriptContext;
  timeoutSeconds: number | null;
  getWindow: () => BrowserWindow | null;
  kind: WorkspaceRuntimeScriptKind;
  interactive?: boolean;
  lifecycle: WorktreeSetupLifecycle;
  tracker?: WorkspaceSetupRunTracker;
  onStarted?: (ref: WorktreeSetupScriptRef) => void;
}): Promise<WorktreeSetupScriptResult> {
  assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId);
  const runId = randomUUID();
  // The worker writes the run log under this run id.
  const scriptLogRef = { projectId: workspaceId, worktreeId, script, runId };
  const scriptRef: WorktreeSetupScriptRef = {
    scriptKey: script.scriptKey,
    runId,
    target: script.target,
    lifecycle,
    ...(script.repoId !== undefined ? { repoId: script.repoId } : {}),
    logRef: scriptLogRef,
  };
  onStarted?.(scriptRef);
  markSetupResolved(tracker, true);
  const observer = tracker?.observer;
  notifyWorktreeSetupObserver('script-started', () =>
    observer?.onScriptStarted?.(scriptRef),
  );
  emitScriptStarted(getWindow, workspaceId, worktreeId, script, kind, runId);

  try {
    const { response: result } = await runDesktopScript(
      {
        projectId: workspaceId,
        worktreeId,
        context,
        script,
        invocation: kind,
        command,
        ...(shell ? { shell } : {}),
        timeoutSeconds: interactive === true ? null : timeoutSeconds,
        interactive: interactive === true,
        backgroundPriority: kind === 'automatic-setup',
        runId,
      },
      {
        observer: {
          onLines: (lines: string[]): void => {
            emitScriptOutput(
              getWindow,
              workspaceId,
              worktreeId,
              script,
              kind,
              lines,
              runId,
            );
          },
        },
      },
    );
    const scriptResult = buildWorktreeSetupScriptResult(scriptRef, result);
    notifySetupScriptCompleted(tracker, scriptResult);
    emitScriptComplete(
      getWindow,
      workspaceId,
      worktreeId,
      script,
      kind,
      result,
      runId,
    );
    return scriptResult;
  } catch (error) {
    // A throw after completion (the broadcast) keeps the real run: its
    // canonical log is not rewritten and the result the observer saw stands.
    const reported = tracker?.completed.get(runId);
    if (reported) {
      return reported;
    }
    const failureResult: ScriptRunResponse = {
      success: false,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: 0,
    };
    // The worker closed the run log of any run it started.
    const scriptResult = buildWorktreeSetupScriptResult(
      scriptRef,
      failureResult,
    );
    notifySetupScriptCompleted(tracker, scriptResult);
    emitScriptComplete(
      getWindow,
      workspaceId,
      worktreeId,
      script,
      kind,
      failureResult,
      runId,
    );
    return scriptResult;
  }
}

async function runWorkspaceRootScript(
  workspaceId: string,
  worktreeId: string,
  scriptName: 'before-setup' | 'after-setup',
  command: string,
  devServerPattern: ScriptDevServerPattern | undefined,
  shell: CommandShellDefinition | undefined,
  interactive: boolean | undefined,
  workspaceRootPath: string,
  timeoutSeconds: number | null,
  getWindow: () => BrowserWindow | null,
  tracker: WorkspaceSetupRunTracker,
): Promise<WorktreeSetupScriptResult> {
  const script = createWorkspaceRootScriptDescriptor(
    scriptName,
    command,
    devServerPattern,
    shell,
    interactive,
  );
  return runWorkspaceRuntimeScript({
    workspaceId,
    worktreeId,
    script,
    command,
    shell,
    interactive,
    context: { kind: 'workspace-root' },
    timeoutSeconds,
    getWindow,
    kind: 'workspace-lifecycle',
    lifecycle: scriptName,
    tracker,
  });
}

async function runRepoSetupScript(
  workspaceId: string,
  worktreeId: string,
  repo: WorkspaceRepoData,
  workspaceRootPath: string,
  repoPath: string,
  defaultTimeoutSeconds: number,
  getWindow: () => BrowserWindow | null,
  tracker?: WorkspaceSetupRunTracker,
  onStarted?: (ref: WorktreeSetupScriptRef) => void,
): Promise<WorktreeSetupScriptResult | null> {
  const resolvedScripts = await resolveWorkspaceRepoScripts(
    workspaceId,
    repo.id,
    {
      workspaceRootPath,
      repoPath,
    },
  );
  const definition = getResolvedScriptDefinition(resolvedScripts, 'setup');
  if (!definition) {
    return null;
  }
  const command = definition.command;
  const timeoutSeconds = resolveEffectiveScriptTimeoutSeconds({
    scriptName: 'setup',
    configuredTimeoutSeconds: definition.timeoutSeconds,
    defaultTimeoutSeconds,
  });

  const script = createWorkspaceRepoScriptDescriptor(
    repo.id,
    repo.name,
    'setup',
    command,
    definition.devServerPattern,
    definition.shell,
    definition.interactive,
  );
  return runWorkspaceRuntimeScript({
    workspaceId,
    worktreeId,
    script,
    command,
    shell: definition.shell,
    interactive: definition.interactive,
    context: { kind: 'workspace-repo', repoId: repo.id },
    timeoutSeconds,
    getWindow,
    kind: 'automatic-setup',
    lifecycle: 'setup',
    tracker,
    onStarted,
  });
}

export function startWorkspaceRepoSetupAndDiscovery(params: {
  workspaceId: string;
  worktreeId: string;
  repo: WorkspaceRepoData;
  getWindow: () => BrowserWindow | null;
}): Promise<void> {
  return withWorkspaceTargetRuntimePreparation(
    params.workspaceId,
    params.worktreeId,
    async (): Promise<void> => {
      const setupStartedCreatedAt = await getWorkspaceWorktreeCreatedAt(
        params.workspaceId,
        params.worktreeId,
      ).catch(() => null);
      try {
        const prefs = await readPreferencesFile();
        const defaultTimeoutSeconds = prefs.scriptTimeoutMinutes * 60;
        const workspaceRootPath = getWorkspaceWorktreeDir(
          params.workspaceId,
          params.worktreeId,
        );
        const repoPath = getWorkspaceWorktreeRepoDir(
          params.workspaceId,
          params.worktreeId,
          params.repo.id,
        );
        await runRepoSetupScript(
          params.workspaceId,
          params.worktreeId,
          params.repo,
          workspaceRootPath,
          repoPath,
          defaultTimeoutSeconds,
          params.getWindow,
        );
      } finally {
        if (
          await canStartPostSetupWork(
            params.workspaceId,
            params.worktreeId,
            setupStartedCreatedAt,
          )
        ) {
          triggerDiscovery(
            params.workspaceId,
            params.worktreeId,
            params.getWindow,
          );
        }
      }
    },
  ).catch(() => undefined);
}

export async function resolveWorkspaceWorktreeBranchName(
  workspaceId: string,
  worktreeId: string,
  repoIdToSkip?: string,
): Promise<string> {
  const config = await readWorkspaceConfig(workspaceId);
  const workspaceRootPath = getWorkspaceWorktreeDir(workspaceId, worktreeId);
  let branchName = worktreeId;

  if (config.sourceRepoPath) {
    try {
      const rootBranch = await getCurrentBranch(workspaceRootPath);
      if (rootBranch && rootBranch !== 'HEAD') {
        branchName = rootBranch;
      }
    } catch {
      // Fall back to child repo inspection below.
    }
  }

  try {
    const configuredRepoIds = new Set(
      config.repos
        .map((repo) => repo.id)
        .filter((repoId) => repoId !== repoIdToSkip),
    );
    const reposDir = getWorkspaceWorktreeReposDir(workspaceId, worktreeId);
    const entries = await readdir(reposDir, { withFileTypes: true });
    const otherBranches: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !configuredRepoIds.has(entry.name)) {
        continue;
      }

      try {
        const branch = await getCurrentBranch(join(reposDir, entry.name));
        if (branch && branch !== 'HEAD') {
          otherBranches.push(branch);
        }
      } catch {
        // Ignore unreachable repo directories.
      }
    }

    const uniqueBranches = new Set(otherBranches);
    if (uniqueBranches.size === 1 && otherBranches.length > 0) {
      return otherBranches[0];
    }
  } catch {
    // repos/ dir may not exist yet
  }

  return branchName;
}

export interface WorkspaceWorktreePostCreateSetupParams {
  workspaceId: string;
  worktreeId: string;
  workspaceRootPath?: string;
  repos: WorkspaceRepoData[];
  getWindow: () => BrowserWindow | null;
}

/**
 * Fire-and-forget form of `runWorkspaceWorktreePostCreateSetup` for the UI and
 * lifecycle callers. It never rejects; the promise lets callers track
 * settlement.
 */
export function startWorkspaceWorktreePostCreateSetup(
  params: WorkspaceWorktreePostCreateSetupParams,
): Promise<void> {
  return runWorkspaceWorktreePostCreateSetup(params).then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Run a workspace worktree's post-create setup lifecycle to completion and
 * return every started script's result.
 *
 * Order: `before-setup` (its failure stops later phases), then every
 * repository's `setup` concurrently (all started repositories settle; a
 * rejected repository becomes a `failed` result with exit code 1), then
 * `after-setup`. Results are listed in that order with repositories in
 * configured order. Discovery and code-graph work still run only while the
 * worktree is current and not being archived.
 *
 * Errors inside the lifecycle resolve as a `failed` result carrying the
 * scripts that already ran; the promise rejects only when preparation is
 * refused up front.
 */
export function runWorkspaceWorktreePostCreateSetup(
  params: WorkspaceWorktreePostCreateSetupParams & {
    observer?: WorktreeSetupObserver;
  },
): Promise<WorktreeSetupRunResult> {
  return withWorkspaceTargetRuntimePreparation(
    params.workspaceId,
    params.worktreeId,
    async (): Promise<WorktreeSetupRunResult> => {
      const tracker: WorkspaceSetupRunTracker = {
        observer: params.observer,
        resolved: false,
        completed: new Map(),
      };
      const scripts: WorktreeSetupScriptResult[] = [];
      const finish = (detail?: string): WorktreeSetupRunResult => {
        if (detail !== undefined) {
          // An error is not "nothing configured": `onResolved` stays silent.
          return { status: 'failed', scripts, detail };
        }
        markSetupResolved(tracker, scripts.length > 0);
        return { status: getWorktreeSetupRunStatus(scripts), scripts };
      };
      const setupStartedCreatedAt = await getWorkspaceWorktreeCreatedAt(
        params.workspaceId,
        params.worktreeId,
      ).catch(() => null);
      const workspaceRootPath =
        params.workspaceRootPath ??
        getWorkspaceWorktreeDir(params.workspaceId, params.worktreeId);

      try {
        const prefs = await readPreferencesFile();
        const defaultTimeoutSeconds = prefs.scriptTimeoutMinutes * 60;
        const workspaceRootScripts = await resolveWorkspaceRootScripts(
          params.workspaceId,
          {
            workspaceRootPath,
          },
        );
        const beforeSetup = getResolvedScriptDefinition(
          workspaceRootScripts,
          'before-setup',
        );
        if (beforeSetup) {
          const timeoutSeconds = resolveEffectiveScriptTimeoutSeconds({
            scriptName: 'before-setup',
            configuredTimeoutSeconds: beforeSetup.timeoutSeconds,
            defaultTimeoutSeconds,
          });
          const beforeSetupResult = await runWorkspaceRootScript(
            params.workspaceId,
            params.worktreeId,
            'before-setup',
            beforeSetup.command,
            beforeSetup.devServerPattern,
            beforeSetup.shell,
            beforeSetup.interactive,
            workspaceRootPath,
            timeoutSeconds,
            params.getWindow,
            tracker,
          );
          scripts.push(beforeSetupResult);
          if (beforeSetupResult.status !== 'succeeded') {
            if (
              await canStartPostSetupWork(
                params.workspaceId,
                params.worktreeId,
                setupStartedCreatedAt,
              )
            ) {
              triggerDiscovery(
                params.workspaceId,
                params.worktreeId,
                params.getWindow,
              );
            }
            return finish();
          }
        }

        const startedRepoScripts = new Map<string, WorktreeSetupScriptRef>();
        const repoOutcomes = await Promise.allSettled(
          params.repos.map(async (repo) => {
            const repoPath = getWorkspaceWorktreeRepoDir(
              params.workspaceId,
              params.worktreeId,
              repo.id,
            );
            assertWorkspaceTargetRuntimeStartAllowed(
              params.workspaceId,
              params.worktreeId,
            );
            await mkdir(dirname(repoPath), { recursive: true });
            return runRepoSetupScript(
              params.workspaceId,
              params.worktreeId,
              repo,
              workspaceRootPath,
              repoPath,
              defaultTimeoutSeconds,
              params.getWindow,
              tracker,
              (ref) => {
                startedRepoScripts.set(repo.id, ref);
              },
            );
          }),
        );
        repoOutcomes.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') {
            if (outcome.value) {
              scripts.push(outcome.value);
            }
            return;
          }
          const repo = params.repos[index];
          if (!repo) {
            return;
          }
          scripts.push(
            buildRejectedRepoSetupResult(
              repo.id,
              startedRepoScripts.get(repo.id),
              tracker,
            ),
          );
        });

        const afterSetupScripts = await resolveWorkspaceRootScripts(
          params.workspaceId,
          {
            workspaceRootPath,
          },
        );
        const afterSetup = getResolvedScriptDefinition(
          afterSetupScripts,
          'after-setup',
        );
        if (afterSetup) {
          const timeoutSeconds = resolveEffectiveScriptTimeoutSeconds({
            scriptName: 'after-setup',
            configuredTimeoutSeconds: afterSetup.timeoutSeconds,
            defaultTimeoutSeconds,
          });
          scripts.push(
            await runWorkspaceRootScript(
              params.workspaceId,
              params.worktreeId,
              'after-setup',
              afterSetup.command,
              afterSetup.devServerPattern,
              afterSetup.shell,
              afterSetup.interactive,
              workspaceRootPath,
              timeoutSeconds,
              params.getWindow,
              tracker,
            ),
          );
        }
        return finish();
      } catch (error) {
        return finish(error instanceof Error ? error.message : String(error));
      } finally {
        // Post-setup work never replaces the scripts' result.
        try {
          if (
            await canStartPostSetupWork(
              params.workspaceId,
              params.worktreeId,
              setupStartedCreatedAt,
            )
          ) {
            triggerDiscovery(
              params.workspaceId,
              params.worktreeId,
              params.getWindow,
            );
            scheduleCodeGraphBuild({
              projectId: params.workspaceId,
              worktreeId: params.worktreeId,
              reason: 'worktree-created',
            });
          }
        } catch {
          // Discovery is best effort, as it was for the fire-and-forget path.
        }
      }
    },
  );
}

/**
 * A repository branch rejected (preparation refused, parent directory or
 * script resolution failed, or the completion broadcast threw). A script that
 * already reported completion keeps that result. Otherwise it becomes a
 * `failed` result with exit code 1: when the script had started, the result
 * keeps its run and log identity and completes the observer's pair; otherwise
 * it carries a generated run ID and no log, and the observer is not notified
 * because no script started.
 */
function buildRejectedRepoSetupResult(
  repoId: string,
  startedRef: WorktreeSetupScriptRef | undefined,
  tracker: WorkspaceSetupRunTracker,
): WorktreeSetupScriptResult {
  const ref: WorktreeSetupScriptRef = startedRef ?? {
    scriptKey: createScriptKey('workspace-repo', 'setup', repoId),
    runId: randomUUID(),
    target: 'workspace-repo',
    lifecycle: 'setup',
    repoId,
    logRef: null,
  };
  // The script completed before the branch rejected: its real result stands.
  const reported = startedRef
    ? tracker.completed.get(startedRef.runId)
    : undefined;
  if (reported) {
    return reported;
  }
  const result = buildWorktreeSetupScriptResult(ref, {
    success: false,
    exitCode: 1,
    timedOut: false,
  });
  if (startedRef) {
    notifySetupScriptCompleted(tracker, result);
  }
  return result;
}
