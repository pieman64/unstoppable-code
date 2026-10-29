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
import { runShellScript } from './script-runner';
import { buildWorktreeDataEnv } from './worktree-data-env';
import { setBrandEnv } from '@canopy/desktop-shared/brand/env';
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
  resolveEffectiveScriptTimeoutSeconds,
  type CommandShellDefinition,
  type ScriptDevServerPattern,
} from '@canopy/desktop-shared/scripts';
import {
  appendScriptRunLogLines,
  completeScriptRunLog,
  startScriptRunLog,
} from './script-log-store';
import { readPreferencesFile } from '../lib/preferences-store';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import {
  getWorkspaceWorktreeCreatedAt,
  isWorkspaceWorktreeCurrent,
  readWorkspaceConfig,
} from './workspace-persistence';

type WorkspaceRuntimeScriptDescriptor = ReturnType<
  | typeof createWorkspaceRootScriptDescriptor
  | typeof createWorkspaceRepoScriptDescriptor
>;

type WorkspaceRuntimeScriptKind = 'workspace-lifecycle' | 'automatic-setup';

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
  cwd,
  env,
  timeoutSeconds,
  getWindow,
  kind,
  interactive,
}: {
  workspaceId: string;
  worktreeId: string;
  script: WorkspaceRuntimeScriptDescriptor;
  command: string;
  shell?: CommandShellDefinition;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSeconds: number | null;
  getWindow: () => BrowserWindow | null;
  kind: WorkspaceRuntimeScriptKind;
  interactive?: boolean;
}): Promise<boolean> {
  assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId);
  const scriptLogRef = await startScriptRunLog({
    projectId: workspaceId,
    worktreeId,
    script,
    invocation: kind,
  }).catch(() => null);
  const runId = scriptLogRef?.runId ?? randomUUID();
  emitScriptStarted(getWindow, workspaceId, worktreeId, script, kind, runId);

  try {
    const result = await runShellScript({
      script: command,
      cwd,
      env,
      shell,
      timeoutSeconds: interactive === true ? null : timeoutSeconds,
      backgroundPriority: kind === 'automatic-setup',
      interactive: interactive === true,
      onChunk: (lines: string[]): void => {
        if (scriptLogRef) {
          void appendScriptRunLogLines({
            ref: scriptLogRef,
            lines,
          }).catch(() => {});
        }
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
      tracking: {
        projectId: workspaceId,
        worktreeId,
        scriptKey: script.scriptKey,
        runId,
        script,
        invocation: kind,
        logRef: scriptLogRef ?? undefined,
      },
    });
    if (scriptLogRef) {
      await completeScriptRunLog({
        ref: scriptLogRef,
        response: result,
      }).catch(() => {});
    }
    emitScriptComplete(
      getWindow,
      workspaceId,
      worktreeId,
      script,
      kind,
      result,
      runId,
    );
    return result.success;
  } catch (error) {
    const failureResult: ScriptRunResponse = {
      success: false,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error),
      timedOut: false,
      durationMs: 0,
    };
    if (scriptLogRef) {
      await appendScriptRunLogLines({
        ref: scriptLogRef,
        lines: [failureResult.output],
      }).catch(() => {});
      await completeScriptRunLog({
        ref: scriptLogRef,
        response: failureResult,
      }).catch(() => {});
    }
    emitScriptComplete(
      getWindow,
      workspaceId,
      worktreeId,
      script,
      kind,
      failureResult,
      runId,
    );
    return false;
  }
}

async function runWorkspaceRootScript(
  workspaceId: string,
  worktreeId: string,
  scriptName: string,
  command: string,
  devServerPattern: ScriptDevServerPattern | undefined,
  shell: CommandShellDefinition | undefined,
  interactive: boolean | undefined,
  workspaceRootPath: string,
  timeoutSeconds: number | null,
  getWindow: () => BrowserWindow | null,
): Promise<boolean> {
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
    cwd: workspaceRootPath,
    env: buildWorktreeDataEnv(workspaceId, worktreeId, undefined, {
      runtime: 'canopy',
    }),
    timeoutSeconds,
    getWindow,
    kind: 'workspace-lifecycle',
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
): Promise<void> {
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
    return;
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
  const childRepoEnv: NodeJS.ProcessEnv = {};
  setBrandEnv(childRepoEnv, 'WORKSPACE_CHILD_REPO_ID', repo.id);

  await runWorkspaceRuntimeScript({
    workspaceId,
    worktreeId,
    script,
    command,
    shell: definition.shell,
    interactive: definition.interactive,
    cwd: repoPath,
    env: buildWorktreeDataEnv(workspaceId, worktreeId, childRepoEnv, {
      runtime: 'canopy',
    }),
    timeoutSeconds,
    getWindow,
    kind: 'automatic-setup',
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

export function startWorkspaceWorktreePostCreateSetup(params: {
  workspaceId: string;
  worktreeId: string;
  workspaceRootPath?: string;
  repos: WorkspaceRepoData[];
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
          const success = await runWorkspaceRootScript(
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
          );
          if (!success) {
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
            return;
          }
        }

        await Promise.allSettled(
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
            await runRepoSetupScript(
              params.workspaceId,
              params.worktreeId,
              repo,
              workspaceRootPath,
              repoPath,
              defaultTimeoutSeconds,
              params.getWindow,
            );
          }),
        );

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
          );
        }
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
          scheduleCodeGraphBuild({
            projectId: params.workspaceId,
            worktreeId: params.worktreeId,
            reason: 'worktree-created',
          });
        }
      }
    },
  ).catch(() => undefined);
}
