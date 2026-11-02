import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getHookActionLogLabel,
  interpolateHookPrompt,
  type ChatHookAction,
  type PipelineHookAction,
} from '@canopy/desktop-shared/hooks';
import { setBrandEnv } from '@canopy/desktop-shared/brand/env';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import { buildPrQueueHookVariables } from '@canopy/desktop-shared/lib/pr-merge-queue';
import type { BrowserWindow } from 'electron';
import type {
  HookDescriptor,
  HookRunResponse,
  HookStopRequest,
} from '@canopy/desktop-shared/types';
import { buildWorktreeDataEnv } from './worktree-data-env';
import {
  appendHookRunLogLines,
  completeHookRunLog,
  startHookRunLog,
  type HookRunLogRef,
} from './hook-log-store';
import { getHookInvocationDir } from './paths';
import { runShellScript } from './script-runner';
import type { PipelineTriggerSource } from '@canopy/desktop-shared/node/pipelines/executor';
import { assertWorkspaceTargetRuntimeStartAllowed } from './workspace-target-exclusion';

interface ActiveHookRun {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  targetKey: string;
  abortController: AbortController;
  running: boolean;
  waitForExit: Promise<HookRunResponse>;
}

export interface RunHookOptions {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  cwd: string;
  invocation: 'automatic' | 'manual';
  timeoutSeconds?: number | null;
  currentSnapshot?: PersistedPrSnapshotFileV1;
  currentSnapshotPath?: string;
  previousSnapshotPath?: string;
  env?: NodeJS.ProcessEnv;
  getWindow: () => BrowserWindow | null;
  onEnqueued?: () => void;
  onStarted?: (hook: HookDescriptor, ref: HookRunLogRef) => void;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  onComplete?: (
    hook: HookDescriptor,
    result: HookRunResponse,
    ref: HookRunLogRef,
  ) => void;
}

const activeHookRuns = new Map<string, ActiveHookRun[]>();
const activeHookRunListeners = new Set<() => void>();
const targetQueues = new Map<string, Promise<void>>();
const targetCancellationGenerations = new Map<string, number>();

function notifyActiveHookRunsChanged(): void {
  activeHookRunListeners.forEach((listener): void => {
    // A throwing subscriber must not disturb hook execution or other
    // listeners; this registry is observational only.
    try {
      listener();
    } catch {
      // Ignore listener failures.
    }
  });
}

export function subscribeActiveHookRunsChanged(
  listener: () => void,
): () => void {
  activeHookRunListeners.add(listener);
  return (): void => {
    activeHookRunListeners.delete(listener);
  };
}

export function listActiveHookRunTargets(): Array<{
  projectId: string;
  worktreeId: string;
}> {
  return Array.from(activeHookRuns.values()).flatMap((runs) =>
    runs
      .filter((run) => run.running)
      .map((run) => ({
        projectId: run.projectId,
        worktreeId: run.worktreeId,
      })),
  );
}

function buildActiveKey(
  projectId: string,
  worktreeId: string,
  hookKey: string,
): string {
  return `${projectId}\0${worktreeId}\0${hookKey}`;
}

function buildTargetKey(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
): string {
  return buildTargetScopeKey(projectId, worktreeId, hook.target, hook.repoId);
}

function buildTargetScopeKey(
  projectId: string,
  worktreeId: string,
  target: HookDescriptor['target'],
  repoId?: string,
): string {
  return `${projectId}\0${worktreeId}\0${target}\0${repoId ?? ''}`;
}

function getTargetCancellationGeneration(targetKey: string): number {
  return targetCancellationGenerations.get(targetKey) ?? 0;
}

function cancelQueuedHooksForTarget(targetKey: string): void {
  targetCancellationGenerations.set(
    targetKey,
    getTargetCancellationGeneration(targetKey) + 1,
  );
}

function buildCancelledHookRunResponse(message: string): HookRunResponse {
  return {
    success: false,
    stopped: true,
    exitCode: null,
    output: message,
    timedOut: false,
    durationMs: 0,
  };
}

function toHookRunResponse(result: HookRunResponse): HookRunResponse {
  return {
    ...result,
    stopped: result.stopped ?? (result.exitCode === null && !result.timedOut),
  };
}

async function emitHookOutput(args: {
  ref: Awaited<ReturnType<typeof startHookRunLog>>;
  hook: HookDescriptor;
  lines: string[];
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  activeActionIndex?: number;
}): Promise<void> {
  await appendHookRunLogLines({
    ref: args.ref,
    lines: args.lines,
    activeActionIndex: args.activeActionIndex,
  }).catch(() => {});
  args.onOutput?.(args.hook, args.lines, args.ref, args.activeActionIndex);
}

function buildChatIfCommandStopResponse(args: {
  result: HookRunResponse;
  durationMs: number;
}): HookRunResponse {
  const message =
    args.result.output.trim().length > 0
      ? args.result.output
      : 'Chat if-command exited with code 2 and intentionally stopped the hook.';

  return {
    success: false,
    stopped: true,
    exitCode: 2,
    output: message,
    timedOut: false,
    durationMs: args.durationMs,
  };
}

function buildChatIfCommandFailureResponse(args: {
  result: HookRunResponse;
  durationMs: number;
}): HookRunResponse {
  const fallbackMessage = args.result.timedOut
    ? 'Chat if-command timed out.'
    : args.result.stopped
      ? 'Chat if-command was cancelled before completion.'
      : args.result.exitCode === null
        ? 'Chat if-command failed without an exit code.'
        : `Chat if-command failed with exit code ${args.result.exitCode}.`;
  const message =
    args.result.output.trim().length > 0 ? args.result.output : fallbackMessage;

  return {
    ...args.result,
    output: message,
    durationMs: args.durationMs,
  };
}

async function runChatIfCommand(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  action: ChatHookAction;
  cwd: string;
  timeoutSeconds?: number | null;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  logRef: Awaited<ReturnType<typeof startHookRunLog>>;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
  activeActionIndex: number;
}): Promise<HookRunResponse | null> {
  const ifCommand = args.action['if-command'];
  if (!ifCommand) {
    return null;
  }

  await emitHookOutput({
    ref: args.logRef,
    hook: args.hook,
    lines: ['Running chat if-command gate.'],
    onOutput: args.onOutput,
    activeActionIndex: args.activeActionIndex,
  });

  const startedAt = Date.now();
  const gateResult = toHookRunResponse(
    await runShellScript({
      script: ifCommand,
      cwd: args.cwd,
      timeoutSeconds: args.timeoutSeconds,
      signal: args.signal,
      env: args.env,
      onChunk: (lines: string[]): void => {
        void emitHookOutput({
          ref: args.logRef,
          hook: args.hook,
          lines,
          onOutput: args.onOutput,
          activeActionIndex: args.activeActionIndex,
        }).catch(() => {});
      },
      tracking: {
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        scriptKey: args.hook.hookKey,
      },
    }),
  );

  const durationMs = Date.now() - startedAt;
  if (gateResult.success) {
    return null;
  }

  if (!gateResult.timedOut && gateResult.exitCode === 2) {
    const stoppedResult = buildChatIfCommandStopResponse({
      result: gateResult,
      durationMs,
    });
    if (stoppedResult.output !== gateResult.output) {
      await emitHookOutput({
        ref: args.logRef,
        hook: args.hook,
        lines: [stoppedResult.output],
        onOutput: args.onOutput,
        activeActionIndex: args.activeActionIndex,
      });
    }
    return stoppedResult;
  }

  const failedResult = buildChatIfCommandFailureResponse({
    result: gateResult,
    durationMs,
  });
  if (failedResult.output !== gateResult.output) {
    await emitHookOutput({
      ref: args.logRef,
      hook: args.hook,
      lines: [failedResult.output],
      onOutput: args.onOutput,
      activeActionIndex: args.activeActionIndex,
    });
  }
  return failedResult;
}

async function runPipelineAction(args: {
  projectId: string;
  worktreeId: string;
  hook: HookDescriptor;
  action: PipelineHookAction;
  actionIndex: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  getWindow: () => BrowserWindow | null;
  logRef: Awaited<ReturnType<typeof startHookRunLog>>;
  onOutput?: (
    hook: HookDescriptor,
    lines: string[],
    ref?: HookRunLogRef,
    activeActionIndex?: number,
  ) => void;
}): Promise<HookRunResponse> {
  const { launchHookPipeline } = await import('./hook-pipeline');
  const startedAt = Date.now();
  const triggerSource: PipelineTriggerSource = {
    kind: 'hook',
    hook_key: args.hook.hookKey,
    hook_label: args.hook.label,
    trigger_name: args.hook.triggerName,
    target: args.hook.target,
    action_index: args.actionIndex,
    triggered_at: new Date().toISOString(),
  };
  if (args.hook.repoId !== undefined) {
    triggerSource.repo_id = args.hook.repoId;
  }
  if (args.hook.repoName !== undefined) {
    triggerSource.repo_name = args.hook.repoName;
  }

  const launched = await launchHookPipeline({
    action: args.action,
    cwd: args.cwd,
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    env: args.env,
    triggerSource,
    getWindow: args.getWindow,
  });
  const line =
    launched.status === 'started'
      ? `Started workflow "${launched.pipelineName}".`
      : `Queued workflow "${launched.pipelineName}" — waiting for active workflow runs to finish.`;

  await emitHookOutput({
    ref: args.logRef,
    hook: args.hook,
    lines: [line],
    onOutput: args.onOutput,
    activeActionIndex: args.actionIndex,
  });

  return {
    success: true,
    stopped: false,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: Date.now() - startedAt,
  };
}

function buildHookEnv(
  projectId: string,
  worktreeId: string,
  hook: HookDescriptor,
  snapshot: PersistedPrSnapshotFileV1 | undefined,
  currentSnapshotPath: string | undefined,
  previousSnapshotPath: string | undefined,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const snapshotEnv: NodeJS.ProcessEnv = { ...env };
  if (hook.target === 'workspace-repo' && hook.repoId) {
    setBrandEnv(snapshotEnv, 'WORKSPACE_CHILD_REPO_ID', hook.repoId);
  }
  if (snapshot && currentSnapshotPath) {
    if (previousSnapshotPath) {
      setBrandEnv(snapshotEnv, 'PR_PREV_FILE', previousSnapshotPath);
    }
    setBrandEnv(snapshotEnv, 'PR_CURRENT_FILE', currentSnapshotPath);
    setBrandEnv(snapshotEnv, 'PR_BRANCH', snapshot.branch.headRefName);
    setBrandEnv(snapshotEnv, 'PR_BASE_BRANCH', snapshot.branch.baseRefName);
    setBrandEnv(snapshotEnv, 'PR_REPO_NAME', snapshot.repository.name);
    setBrandEnv(snapshotEnv, 'PR_REPO_OWNER', snapshot.repository.owner);
    setBrandEnv(snapshotEnv, 'PR_NUMBER', String(snapshot.pr.number));
    setBrandEnv(snapshotEnv, 'PR_ID', String(snapshot.pr.number));
    setBrandEnv(snapshotEnv, 'PR_URL', snapshot.pr.htmlUrl);
    for (const [name, value] of Object.entries(
      buildPrQueueHookVariables(snapshot, hook.triggerName),
    )) {
      setBrandEnv(snapshotEnv, name, value);
    }
  }

  return buildWorktreeDataEnv(projectId, worktreeId, snapshotEnv, {
    runtime: 'canopy',
  });
}

async function prepareInvocationSnapshotFiles(args: {
  projectId: string;
  worktreeId: string;
  runId: string;
  currentSnapshot: PersistedPrSnapshotFileV1;
  currentSnapshotPath?: string;
  previousSnapshotPath?: string;
}): Promise<{
  currentSnapshotPath: string;
  previousSnapshotPath?: string;
}> {
  const invocationDir = getHookInvocationDir(
    args.projectId,
    args.worktreeId,
    args.runId,
  );
  const snapshotsDir = join(invocationDir, 'snapshots');
  await mkdir(snapshotsDir, { recursive: true });

  const copiedCurrentSnapshotPath = join(snapshotsDir, 'current.json');
  if (args.currentSnapshotPath) {
    try {
      await copyFile(args.currentSnapshotPath, copiedCurrentSnapshotPath);
    } catch {
      await writeFile(
        copiedCurrentSnapshotPath,
        JSON.stringify(args.currentSnapshot, null, 2),
        'utf8',
      );
    }
  } else {
    await writeFile(
      copiedCurrentSnapshotPath,
      JSON.stringify(args.currentSnapshot, null, 2),
      'utf8',
    );
  }

  let copiedPreviousSnapshotPath: string | undefined;
  if (args.previousSnapshotPath) {
    copiedPreviousSnapshotPath = join(snapshotsDir, 'previous.json');
    try {
      await copyFile(args.previousSnapshotPath, copiedPreviousSnapshotPath);
    } catch {
      copiedPreviousSnapshotPath = undefined;
    }
  }

  return {
    currentSnapshotPath: copiedCurrentSnapshotPath,
    previousSnapshotPath: copiedPreviousSnapshotPath,
  };
}

async function executeHook(options: RunHookOptions): Promise<HookRunResponse> {
  assertWorkspaceTargetRuntimeStartAllowed(
    options.projectId,
    options.worktreeId,
  );
  const abortController = new AbortController();
  const activeKey = buildActiveKey(
    options.projectId,
    options.worktreeId,
    options.hook.hookKey,
  );
  const targetKey = buildTargetKey(
    options.projectId,
    options.worktreeId,
    options.hook,
  );
  const queueGeneration = getTargetCancellationGeneration(targetKey);
  const registeredRun: ActiveHookRun = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    hook: options.hook,
    targetKey,
    abortController,
    running: false,
    get waitForExit(): Promise<HookRunResponse> {
      return queuedExecution;
    },
  };

  const execute = async (): Promise<HookRunResponse> => {
    if (
      abortController.signal.aborted ||
      getTargetCancellationGeneration(targetKey) !== queueGeneration
    ) {
      return buildCancelledHookRunResponse('Hook run cancelled before start.');
    }
    registeredRun.running = true;
    notifyActiveHookRunsChanged();

    let hookLogRef: Awaited<ReturnType<typeof startHookRunLog>> | null = null;

    let finalResult: HookRunResponse = {
      success: true,
      stopped: false,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 0,
    };

    try {
      const logRef = await startHookRunLog({
        projectId: options.projectId,
        worktreeId: options.worktreeId,
        hook: options.hook,
        invocation: options.invocation,
      });
      hookLogRef = logRef;
      const copiedSnapshots = options.currentSnapshot
        ? await prepareInvocationSnapshotFiles({
            projectId: options.projectId,
            worktreeId: options.worktreeId,
            runId: logRef.runId,
            currentSnapshot: options.currentSnapshot,
            currentSnapshotPath: options.currentSnapshotPath,
            previousSnapshotPath: options.previousSnapshotPath,
          })
        : undefined;
      options.onStarted?.(options.hook, logRef);

      const totalActions = options.hook.actions.length;
      const env = buildHookEnv(
        options.projectId,
        options.worktreeId,
        options.hook,
        options.currentSnapshot,
        copiedSnapshots?.currentSnapshotPath,
        copiedSnapshots?.previousSnapshotPath,
        options.env,
      );

      if (abortController.signal.aborted) {
        finalResult = buildCancelledHookRunResponse('Hook run cancelled.');
        return finalResult;
      }

      for (let index = 0; index < totalActions; index++) {
        const action = options.hook.actions[index];
        const boundary = `$ [${index + 1}/${totalActions}] ${getHookActionLogLabel(action)}`;
        await emitHookOutput({
          ref: logRef,
          hook: options.hook,
          lines: [boundary],
          onOutput: options.onOutput,
          activeActionIndex: index,
        });

        let result: HookRunResponse;
        if (action.type === 'command') {
          result = toHookRunResponse(
            await runShellScript({
              script: action.command,
              cwd: options.cwd,
              shell: action.shell,
              timeoutSeconds:
                action.interactive === true ? null : options.timeoutSeconds,
              signal: abortController.signal,
              env,
              interactive: action.interactive === true,
              terminalTitle: options.hook.label,
              focusOnSpawn: options.invocation === 'manual',
              onChunk: (lines: string[]): void => {
                void emitHookOutput({
                  ref: logRef,
                  hook: options.hook,
                  lines,
                  onOutput: options.onOutput,
                  activeActionIndex: index,
                }).catch(() => {});
              },
              tracking: {
                projectId: options.projectId,
                worktreeId: options.worktreeId,
                scriptKey: options.hook.hookKey,
                kind: 'hook',
              },
            }),
          );
        } else if (action.type === 'chat') {
          result = await (async (): Promise<HookRunResponse> => {
            if (abortController.signal.aborted) {
              return buildCancelledHookRunResponse('Hook run cancelled.');
            }

            const ifCommandResult = await runChatIfCommand({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              hook: options.hook,
              action,
              cwd: options.cwd,
              timeoutSeconds: options.timeoutSeconds,
              signal: abortController.signal,
              env,
              logRef,
              onOutput: options.onOutput,
              activeActionIndex: index,
            });
            if (ifCommandResult) {
              return ifCommandResult;
            }

            const { launchHookChat } = await import('./hook-chat');
            const startedAt = Date.now();
            await launchHookChat({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              action,
              prompt: action.promptReferences?.length
                ? action.prompt
                : interpolateHookPrompt(action.prompt, env),
              ...(action.promptReferences?.length
                ? {
                    interpolateText: (text: string): string =>
                      interpolateHookPrompt(text, env),
                  }
                : {}),
              triggerName: options.hook.triggerName,
              getWindow: options.getWindow,
              ...(options.hook.target === 'workspace-repo' &&
              options.hook.repoId
                ? { selectedRepoId: options.hook.repoId }
                : {}),
            });
            return {
              success: true,
              stopped: false,
              exitCode: 0,
              output: '',
              timedOut: false,
              durationMs: Date.now() - startedAt,
            };
          })();
        } else {
          if (abortController.signal.aborted) {
            result = buildCancelledHookRunResponse('Hook run cancelled.');
          } else {
            result = await runPipelineAction({
              projectId: options.projectId,
              worktreeId: options.worktreeId,
              hook: options.hook,
              action,
              actionIndex: index,
              cwd: options.cwd,
              env,
              getWindow: options.getWindow,
              logRef,
              onOutput: options.onOutput,
            });
          }
        }
        finalResult = result;
        if (!result.success) {
          break;
        }
      }
    } catch (error) {
      finalResult = {
        success: false,
        stopped: false,
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
        timedOut: false,
        durationMs: 0,
      };
      if (hookLogRef) {
        await appendHookRunLogLines({
          ref: hookLogRef,
          lines: [finalResult.output],
        }).catch(() => {});
      }
      options.onOutput?.(
        options.hook,
        [finalResult.output],
        hookLogRef ?? undefined,
      );
    } finally {
      if (hookLogRef) {
        await completeHookRunLog({
          ref: hookLogRef,
          response: finalResult,
        }).catch(() => {});
        options.onComplete?.(options.hook, finalResult, hookLogRef);
      }
      const registeredRuns = activeHookRuns.get(activeKey);
      if (registeredRuns) {
        const registeredIndex = registeredRuns.indexOf(registeredRun);
        if (registeredIndex >= 0) {
          registeredRuns.splice(registeredIndex, 1);
        }
      }
      if (registeredRuns?.length === 0) {
        activeHookRuns.delete(activeKey);
      }
      notifyActiveHookRunsChanged();
    }

    return finalResult;
  };

  const prior = targetQueues.get(targetKey) ?? Promise.resolve();
  const queuedExecution = prior.catch(() => {}).then(execute);
  const queueTail = queuedExecution.then(
    (): void => undefined,
    (): void => undefined,
  );
  targetQueues.set(targetKey, queueTail);
  const registeredRuns = activeHookRuns.get(activeKey) ?? [];
  registeredRuns.push(registeredRun);
  activeHookRuns.set(activeKey, registeredRuns);
  options.onEnqueued?.();
  void queueTail.then((): void => {
    if (targetQueues.get(targetKey) === queueTail) {
      targetQueues.delete(targetKey);
    }
  });

  return queuedExecution;
}

export function runHook(options: RunHookOptions): Promise<HookRunResponse> {
  return executeHook(options);
}

export async function stopRunningHook(
  request: HookStopRequest,
): Promise<HookRunResponse | null> {
  const activeKey = buildActiveKey(
    request.projectId,
    request.worktreeId,
    request.hookKey,
  );
  const registeredRuns = activeHookRuns.get(activeKey);
  if (!registeredRuns?.length) {
    return null;
  }

  const runs = Array.from(registeredRuns);
  for (const run of runs) {
    run.abortController.abort();
  }
  const results = await Promise.all(runs.map((run) => run.waitForExit));
  return results[results.length - 1] ?? null;
}

export async function stopHooksForRepoTarget(args: {
  projectId: string;
  worktreeId: string;
  repoId: string;
}): Promise<void> {
  cancelQueuedHooksForTarget(
    buildTargetScopeKey(
      args.projectId,
      args.worktreeId,
      'workspace-repo',
      args.repoId,
    ),
  );

  const activeRuns: ActiveHookRun[] = [];
  for (const runs of Array.from(activeHookRuns.values())) {
    for (const run of runs) {
      if (
        run.projectId === args.projectId &&
        run.worktreeId === args.worktreeId &&
        run.hook.repoId === args.repoId
      ) {
        activeRuns.push(run);
      }
    }
  }

  for (const run of activeRuns) {
    run.abortController.abort();
    await run.waitForExit.catch(() => {});
  }
}

export async function stopHooksForWorktree(args: {
  projectId: string;
  worktreeId: string;
}): Promise<void> {
  const targetPrefix = `${args.projectId}\0${args.worktreeId}\0`;
  for (const targetKey of Array.from(targetQueues.keys())) {
    if (targetKey.startsWith(targetPrefix)) {
      cancelQueuedHooksForTarget(targetKey);
    }
  }

  const worktreeRuns = Array.from(activeHookRuns.values()).flatMap((runs) =>
    runs.filter(
      (run) =>
        run.projectId === args.projectId && run.worktreeId === args.worktreeId,
    ),
  );
  for (const run of worktreeRuns) {
    run.abortController.abort();
  }
  await Promise.all(worktreeRuns.map((run) => run.waitForExit.catch(() => {})));
}

export function stopAllRunningHooks(): void {
  for (const targetKey of Array.from(targetQueues.keys())) {
    cancelQueuedHooksForTarget(targetKey);
  }

  for (const runs of Array.from(activeHookRuns.values())) {
    for (const run of runs) {
      run.abortController.abort();
    }
  }
}
