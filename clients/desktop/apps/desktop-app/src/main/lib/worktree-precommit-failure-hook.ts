import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type { HookAction, HookScope } from '@canopy/desktop-shared/hooks';
import {
  getHookTriggerDisplayName,
  type HookTriggerName,
} from '@canopy/desktop-shared/hooks';
import { isMultiRepoWorkspace } from './workspace-registry';
import { readWorkspaceConfig } from './workspace-persistence';
import {
  createProjectHookDescriptor,
  createWorkspaceRepoHookDescriptor,
  createWorkspaceRootHookDescriptor,
  createHookCompleteEvent,
  createHookOutputEvent,
  createHookStartedEvent,
} from './hook-events';
import {
  getResolvedHookActions,
  resolveProjectHooks,
  resolveWorkspaceRepoHooks,
  resolveWorkspaceRootHooks,
} from './hook-resolver';
import { runHook } from './hook-runner';
import { resolveWorktreeCwd } from './resolve-worktree';
import { readAllSidebarItems } from './sidebar-items';
import { readPreferencesFile } from './preferences-store';
import { sendToWindow } from './window-send';
import {
  buildHookWatcherVariables,
  fireHookTriggeredWatchers,
  hookKeyForScope,
} from './hook-watcher-events';

export const WORKTREE_PRECOMMIT_FAILURE_TRIGGER: HookTriggerName =
  'worktree:precommit:failure';
export const WORKTREE_PRECOMMIT_FAILURE_ERROR_ENV =
  'CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR';
export const WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE_ENV =
  'CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE';

interface RepoTarget {
  repoPath: string;
  repoId?: string;
  repoName: string;
}

interface ResolvedFailureHook {
  scope: HookScope;
  actions: HookAction[];
}

function scopeForRepoTarget(projectId: string, repo: RepoTarget): HookScope {
  if (!isMultiRepoWorkspace(projectId)) {
    return 'project';
  }
  return repo.repoId === WORKSPACE_ROOT_REPO_ID
    ? 'workspace-root'
    : 'workspace-repo';
}

function getErrorString(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybeStderr = (error as { stderr?: unknown }).stderr;
    if (typeof maybeStderr === 'string' && maybeStderr.trim().length > 0) {
      return maybeStderr.trim();
    }
  }

  return error instanceof Error ? error.message : String(error);
}

export function getPrecommitFailureErrorText(error: unknown): string {
  return getErrorString(error).replace(/\s+$/g, '');
}

async function resolveFailureHook(args: {
  projectId: string;
  worktreeId: string;
  repo: RepoTarget;
}): Promise<ResolvedFailureHook | null> {
  if (!isMultiRepoWorkspace(args.projectId)) {
    const config = await readWorkspaceConfig(args.projectId);
    const resolvedHooks = await resolveProjectHooks(
      {
        id: args.projectId,
        owner: config.owner,
        repoPath: config.repoPath ?? args.repo.repoPath,
        hooks: config.hooks,
      },
      args.repo.repoPath,
    );
    const actions = getResolvedHookActions(
      resolvedHooks,
      WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
    );
    return Array.isArray(actions) && actions.length > 0
      ? { scope: 'project', actions }
      : null;
  }

  if (args.repo.repoId === WORKSPACE_ROOT_REPO_ID) {
    const resolvedHooks = await resolveWorkspaceRootHooks(args.projectId, {
      workspaceRootPath: args.repo.repoPath,
    });
    const actions = getResolvedHookActions(
      resolvedHooks,
      WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
    );
    return Array.isArray(actions) && actions.length > 0
      ? { scope: 'workspace-root', actions }
      : null;
  }

  if (!args.repo.repoId) {
    return null;
  }

  const resolvedHooks = await resolveWorkspaceRepoHooks(
    args.projectId,
    args.repo.repoId,
    {
      workspaceRootPath: resolveWorktreeCwd(args.projectId, args.worktreeId),
      repoPath: args.repo.repoPath,
    },
  );
  const actions = getResolvedHookActions(
    resolvedHooks,
    WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
  );
  return Array.isArray(actions) && actions.length > 0
    ? { scope: 'workspace-repo', actions }
    : null;
}

async function readPausedHookKeys(
  projectId: string,
  worktreeId: string,
): Promise<Set<string>> {
  const { items } = await readAllSidebarItems();
  const item = items.find((candidate) => candidate.id === projectId);
  const worktrees = item && item.type !== 'cowork' ? item.worktrees : [];
  const worktree = worktrees.find((candidate) => candidate.id === worktreeId);
  return new Set(worktree?.pausedHookKeys ?? []);
}

export async function triggerWorktreePrecommitFailureHook(args: {
  projectId: string;
  worktreeId: string;
  repo: RepoTarget;
  error: unknown;
  commitMessage?: string;
  getWindow?: () => BrowserWindow | null;
}): Promise<void> {
  const resolved = await resolveFailureHook(args);
  const scope =
    resolved?.scope ?? scopeForRepoTarget(args.projectId, args.repo);

  const hook = resolved
    ? resolved.scope === 'project'
      ? createProjectHookDescriptor(
          WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
          resolved.actions,
        )
      : resolved.scope === 'workspace-root'
        ? createWorkspaceRootHookDescriptor(
            WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
            resolved.actions,
          )
        : createWorkspaceRepoHookDescriptor(
            args.repo.repoId ?? '',
            args.repo.repoName,
            WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
            resolved.actions,
          )
    : undefined;

  const pausedHookKeys = await readPausedHookKeys(
    args.projectId,
    args.worktreeId,
  ).catch(() => new Set<string>());
  const fallbackHookKey = hookKeyForScope({
    scope,
    triggerName: WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
    repoId: args.repo.repoId,
  });
  const hookKey = hook?.hookKey ?? fallbackHookKey;
  const paused = hookKey ? pausedHookKeys.has(hookKey) : false;
  const env: NodeJS.ProcessEnv = {
    [WORKTREE_PRECOMMIT_FAILURE_ERROR_ENV]: getPrecommitFailureErrorText(
      args.error,
    ),
  };
  if (typeof args.commitMessage === 'string') {
    env[WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE_ENV] = args.commitMessage;
  }
  const variables = buildHookWatcherVariables({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    scope,
    repoId: args.repo.repoId,
    env,
  });
  fireHookTriggeredWatchers({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    triggerName: WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
    scope,
    repoId: args.repo.repoId,
    repoName: args.repo.repoName,
    hook,
    configured: Boolean(hook),
    paused,
    variables,
  });

  if (!hook) {
    return;
  }

  if (paused) {
    sendToWindow(args.getWindow?.() ?? null, IPC_CHANNELS.hookSkippedPaused, {
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      hook,
      triggerDisplayName: getHookTriggerDisplayName(
        WORKTREE_PRECOMMIT_FAILURE_TRIGGER,
      ),
    });
    return;
  }

  const prefs = await readPreferencesFile();
  void runHook({
    projectId: args.projectId,
    worktreeId: args.worktreeId,
    hook,
    cwd: args.repo.repoPath,
    invocation: 'automatic',
    timeoutSeconds: prefs.scriptTimeoutMinutes * 60,
    env,
    getWindow: args.getWindow ?? ((): null => null),
    onStarted: (startedHook) => {
      sendToWindow(
        args.getWindow?.() ?? null,
        IPC_CHANNELS.hookStarted,
        createHookStartedEvent(args.projectId, args.worktreeId, startedHook),
      );
    },
    onOutput: (outputHook, lines, _ref, activeActionIndex) => {
      sendToWindow(
        args.getWindow?.() ?? null,
        IPC_CHANNELS.hookOutput,
        createHookOutputEvent(
          args.projectId,
          args.worktreeId,
          outputHook,
          lines,
          activeActionIndex,
        ),
      );
    },
    onComplete: (completedHook, result) => {
      sendToWindow(
        args.getWindow?.() ?? null,
        IPC_CHANNELS.hookComplete,
        createHookCompleteEvent(
          args.projectId,
          args.worktreeId,
          completedHook,
          result,
        ),
      );
    },
  }).catch(() => {});
}
