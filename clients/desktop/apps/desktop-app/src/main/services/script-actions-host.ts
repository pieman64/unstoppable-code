import { SCRIPT_ACTION_RESERVED_SHORTCUTS } from '@canopy/protocol/script-actions/reserved-shortcuts';
import type { ScriptTerminalShell } from '@canopy/desktop-shared/node/script-detection';
import {
  onScriptActionsRepositoryAdd,
  onScriptActionsTargetClosed,
} from './script-actions-lifecycle';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import type {
  ScriptAction,
  ScriptActionsContext,
} from '@canopy/protocol/script-actions';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  IPC_CHANNELS,
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceScriptActionsPath,
  getScriptAliasesPath,
} from '../lib/paths';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import { sendToAllWindows } from '../lib/window-send';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  listWorktreeScriptEntries,
  getScriptSourceInfo,
} from './scripts-service';
import { workerTerminal } from '../terminal/worker-terminal';
import {
  ScriptActionsError,
  ScriptActionsService,
  type ScriptActionCheckout,
} from './script-actions-service';

async function resolveCheckouts(
  context: ScriptActionsContext,
): Promise<ScriptActionCheckout[]> {
  validateId(context.projectId, 'projectId');
  validateId(context.worktreeId, 'worktreeId');
  const { config, authority } = await readWorkspaceConfigDetailed(
    context.projectId,
  );
  if (authority !== 'ok' || config.type === 'cowork')
    throw new ScriptActionsError(
      'invalid_target',
      'Select an available code workspace.',
    );
  const trees = await readWorkspaceWorktrees(context.projectId);
  if (!trees.some((tree) => tree.id === context.worktreeId))
    throw new ScriptActionsError(
      'invalid_target',
      'Worktree does not belong to this workspace.',
    );
  if (config.repos.length > 31)
    throw new ScriptActionsError(
      'invalid_target',
      'Workspace exceeds the repository scan limit.',
    );
  for (const repo of config.repos) validateId(repo.id, 'repoId');
  if (new Set(config.repos.map((repo) => repo.id)).size !== config.repos.length)
    throw new ScriptActionsError(
      'invalid_target',
      'Workspace repository identities are conflicting.',
    );
  await workerTerminal.prewarmShell();
  if (config.type === 'single-repo')
    return [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: context.projectId,
        root: resolveWorktreeCwd(context.projectId, context.worktreeId),
      },
    ];
  const checkouts = config.repos.map((repo) => ({
    repoId: repo.id,
    repoName: repo.name,
    root: resolveWorktreeCwd(context.projectId, context.worktreeId, repo.id),
  }));
  if (config.sourceRepoPath)
    checkouts.unshift({
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: context.projectId,
      root: resolveWorktreeCwd(context.projectId, context.worktreeId),
    });
  return checkouts;
}
async function resolveRepositorySources(
  projectId: string,
): Promise<ScriptActionCheckout[]> {
  validateId(projectId, 'projectId');
  const { config, authority } = await readWorkspaceConfigDetailed(projectId);
  if (
    authority !== 'ok' ||
    config.type === 'cowork' ||
    config.repos.length > 31
  )
    throw new ScriptActionsError(
      'invalid_target',
      'Select an available code workspace.',
    );
  for (const repo of config.repos) validateId(repo.id, 'repoId');
  if (new Set(config.repos.map((repo) => repo.id)).size !== config.repos.length)
    throw new ScriptActionsError(
      'invalid_target',
      'Workspace repository identities are conflicting.',
    );
  await workerTerminal.prewarmShell();
  if (config.type === 'single-repo' && config.repoPath)
    return [
      {
        repoId: SINGLE_REPO_USAGE_REPO_ID,
        repoName: projectId,
        root: config.repoPath,
      },
    ];
  const repos = config.repos.map((repo) => ({
    repoId: repo.id,
    repoName: repo.name,
    root: repo.repoPath,
  }));
  if (config.sourceRepoPath)
    repos.unshift({
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: projectId,
      root: config.sourceRepoPath,
    });
  return repos;
}
async function tracked(context: ScriptActionsContext): Promise<ScriptAction[]> {
  const entries = await listWorktreeScriptEntries(context);
  const result: ScriptAction[] = [];
  for (const { descriptor, request } of entries) {
    if (!descriptor.command) continue;
    const source = await getScriptSourceInfo(request);
    const active = source.layers.find((layer) => layer.status === 'active');
    const local = active?.sourceKey.includes('local') === true;
    const repoId =
      request.target === 'workspace-repo'
        ? request.repoId
        : request.target === 'project'
          ? SINGLE_REPO_USAGE_REPO_ID
          : null;
    result.push({
      id: descriptor.scriptKey,
      kind: 'tracked',
      name: descriptor.label,
      command: descriptor.command,
      multiline: /[\r\n]/.test(descriptor.command),
      repoId,
      repoName: descriptor.repoName ?? null,
      packagePath: null,
      target: repoId
        ? { kind: 'repository', repoId }
        : { kind: 'workspace-root' },
      source: {
        kind: local ? 'local' : 'canopy',
        file: active?.sourceKey.split(':').pop() ?? 'configuration',
        entry: descriptor.scriptName,
        line: null,
      },
      revision: createHash('sha256')
        .update(JSON.stringify([descriptor, active]))
        .digest('hex'),
      status: 'approved',
      shortcut: null,
      pinned: false,
    });
  }
  return result;
}
export const scriptActionsService = new ScriptActionsService({
  workspacePath: getWorkspaceScriptActionsPath,
  aliasPath: getScriptAliasesPath,
  home: (): string =>
    (__CANOPY_E2E__ && process.env.CANOPY_E2E_SCRIPT_ALIAS_HOME) || homedir(),
  platform: hostPlatformOperatingSystem(),
  shell: (): ScriptTerminalShell => {
    const shell = workerTerminal
      .defaultShellBasename()
      .replace(/\.exe$/i, '')
      .toLowerCase();
    if (
      shell === 'sh' ||
      shell === 'bash' ||
      shell === 'zsh' ||
      shell === 'fish' ||
      shell === 'cmd'
    )
      return shell;
    if (shell === 'powershell' || shell === 'pwsh') return 'powershell';
    throw new ScriptActionsError(
      'unsupported',
      'Terminal shell is not supported for detected scripts.',
    );
  },
  resolve: resolveCheckouts,
  resolveRepositorySources,
  tracked,
  reservedShortcuts: async (): Promise<ReadonlyMap<string, string>> => {
    const preferences = await readPreferencesFile();
    const platform = hostPlatformOperatingSystem();
    const shortcuts = new Map<string, string>(
      SCRIPT_ACTION_RESERVED_SHORTCUTS.map((binding) => [
        platform === 'darwin' ? binding.darwin : binding.other,
        binding.title,
      ]),
    );
    if (preferences.globalFocusShortcutEnabled !== false)
      shortcuts.set(
        preferences.globalFocusShortcut ?? 'CommandOrControl+Shift+O',
        'Focus app',
      );
    return shortcuts;
  },
  changed: (context): void =>
    sendToAllWindows(IPC_CHANNELS.scriptActionsChanged, context),
  found: (receipt): void =>
    sendToAllWindows(IPC_CHANNELS.scriptActionsFound, receipt),
  watch: true,
});

/** Subscription work runs after the durable add and never blocks add completion. */
export function startScriptActionsLifecycle(): () => void {
  const removeAdd = onScriptActionsRepositoryAdd((event) => {
    trackDetachedWork(async () => {
      // Add notices describe the added source repositories even before a worktree exists.
      // Execution snapshots are independently scanned from each selected worktree.
      await scriptActionsService.scanWorkspaceAfterAdd(
        event.projectId,
        event.repoIds,
        event.operationId,
      );
    });
  });
  const removeClose = onScriptActionsTargetClosed((context) =>
    scriptActionsService.closeTarget(context),
  );
  return () => {
    removeAdd();
    removeClose();
  };
}
