import {
  listRunnableHooks,
  normalizeHookInputMap,
  type HookOverrides,
  type HookValue,
} from '@canopy/desktop-shared/hooks';
import {
  WORKSPACE_ROOT_REPO_ID,
  type HookDescriptor,
  type SidebarItem,
  type WorktreeEffectiveOverrides,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  createProjectHookDescriptor,
  createWorkspaceRootHookDescriptor,
  createWorkspaceRepoHookDescriptor,
} from '@/lib/hookDescriptors';
import {
  getSingleRepoWorktreeEffectiveHooks,
  type AppliedProjectWorktreeHooks,
} from '@/lib/projectWorktreeHooks';

export interface HookEntry {
  hook: HookDescriptor;
  request?: Parameters<typeof window.api.runHook>[0];
}

export function hasActivePrForHookEntry(
  entry: HookEntry,
  prStatus: WorktreePrStatus | null | undefined,
): boolean {
  if (!prStatus) {
    return false;
  }

  if (entry.hook.target === 'project') {
    return prStatus.repos.some((repo) => repo.status !== null);
  }

  if (entry.hook.target === 'workspace-root') {
    return prStatus.repos.some(
      (repo) => repo.repoId === WORKSPACE_ROOT_REPO_ID && repo.status !== null,
    );
  }

  if (!entry.hook.repoId) {
    return false;
  }

  return prStatus.repos.some(
    (repo) => repo.repoId === entry.hook.repoId && repo.status !== null,
  );
}

/**
 * Whether a PR event in one repository would run a hook for `triggerName`:
 * a hook is configured at the repository's scope and is not paused in this
 * worktree. Mirrors the main process, which fires a repository's PR hooks
 * from the project, the workspace root, or that workspace repository.
 */
export function isPrHookActiveForRepo(args: {
  entries: readonly HookEntry[];
  pausedHookKeys: readonly string[];
  isMultiRepo: boolean;
  repoId: string | undefined;
  triggerName: string;
}): boolean {
  return args.entries.some((entry) => {
    const { hook } = entry;
    if (hook.triggerName !== args.triggerName) return false;
    if (args.pausedHookKeys.includes(hook.hookKey)) return false;
    if (!args.isMultiRepo) return hook.target === 'project';
    if (args.repoId === WORKSPACE_ROOT_REPO_ID) {
      return hook.target === 'workspace-root';
    }
    return hook.target === 'workspace-repo' && hook.repoId === args.repoId;
  });
}

function hasWorkspaceRootHooks(
  project: Extract<SidebarItem, { type: 'multi-repo' }>,
  wtOverrides: WorktreeEffectiveOverrides | undefined,
): boolean {
  return (
    Boolean(project.sourceRepoPath) ||
    listRunnableHooks(wtOverrides?.effectiveHooks).length > 0
  );
}

function areHookValuesEqual(
  left: HookValue | undefined,
  right: HookValue | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function shouldMergeDisplayHooks(
  baseEffectiveHooks: HookOverrides | undefined,
  worktreeEffectiveHooks: HookOverrides,
  localOverrides: HookOverrides | undefined,
): boolean {
  const normalizedLocalOverrides = normalizeHookInputMap(localOverrides);
  if (!baseEffectiveHooks || !normalizedLocalOverrides) {
    return false;
  }

  const worktreeTriggerNames = Object.keys(worktreeEffectiveHooks);
  if (worktreeTriggerNames.length === 0) {
    return false;
  }

  const localTriggerNames = new Set(Object.keys(normalizedLocalOverrides));
  const hasBaseInheritedHooks = Object.keys(baseEffectiveHooks).some(
    (triggerName) => !localTriggerNames.has(triggerName),
  );
  if (!hasBaseInheritedHooks) {
    return false;
  }

  return worktreeTriggerNames.every((triggerName) => {
    return (
      localTriggerNames.has(triggerName) &&
      areHookValuesEqual(
        worktreeEffectiveHooks[triggerName],
        normalizedLocalOverrides[triggerName],
      )
    );
  });
}

function getDisplayHooks(
  baseEffectiveHooks: HookOverrides | undefined,
  worktreeEffectiveHooks: HookOverrides | undefined,
  localOverrides: HookOverrides | undefined,
): HookOverrides | undefined {
  if (
    !worktreeEffectiveHooks ||
    Object.keys(worktreeEffectiveHooks).length === 0
  ) {
    return baseEffectiveHooks;
  }

  if (
    !shouldMergeDisplayHooks(
      baseEffectiveHooks,
      worktreeEffectiveHooks,
      localOverrides,
    )
  ) {
    return worktreeEffectiveHooks;
  }

  return normalizeHookInputMap({
    ...(baseEffectiveHooks ?? {}),
    ...worktreeEffectiveHooks,
  });
}

export function buildHookEntries(
  project: SidebarItem,
  worktreeId: string,
  appliedProjectWorktreeHooks: AppliedProjectWorktreeHooks,
): HookEntry[] {
  const entries: HookEntry[] = [];
  if (project.type === 'cowork') {
    return entries;
  }
  const wtOverrides = project.worktreeEffective?.[worktreeId];

  if (project.type === 'single-repo') {
    const effectiveHooks = getDisplayHooks(
      getSingleRepoWorktreeEffectiveHooks(
        project,
        worktreeId,
        appliedProjectWorktreeHooks,
      ),
      wtOverrides?.effectiveHooks,
      project.hooks,
    );
    for (const runnableHook of listRunnableHooks(effectiveHooks)) {
      const hook = createProjectHookDescriptor(
        runnableHook.triggerName,
        runnableHook.actions,
      );
      entries.push({
        hook,
        request: {
          target: 'project',
          triggerName: runnableHook.triggerName,
          projectId: project.id,
          worktreeId,
        },
      });
    }
    return entries;
  }

  // Multi-repo: workspace root hooks only exist when the workspace root is a
  // real tracked repo. Some older source-backed workspaces may be missing
  // sourceRepoPath locally, but their selected worktree still resolves root
  // hooks from canopy.json correctly, so use the worktree-resolved hooks as a
  // fallback signal.
  const wsRootHooks = getDisplayHooks(
    project.effectiveHooks,
    wtOverrides?.effectiveHooks,
    project.hooks,
  );
  if (hasWorkspaceRootHooks(project, wtOverrides)) {
    for (const runnableHook of listRunnableHooks(wsRootHooks)) {
      const hook = createWorkspaceRootHookDescriptor(
        runnableHook.triggerName,
        runnableHook.actions,
      );
      entries.push({
        hook,
        request: {
          target: 'workspace-root',
          triggerName: runnableHook.triggerName,
          workspaceId: project.id,
          worktreeId,
        },
      });
    }
  }

  // Multi-repo: per-repo hooks
  for (const repo of project.repos) {
    const repoHooks = getDisplayHooks(
      repo.effectiveHooks,
      wtOverrides?.repos?.[repo.id]?.effectiveHooks,
      repo.hooks,
    );
    for (const runnableHook of listRunnableHooks(repoHooks)) {
      const hook = createWorkspaceRepoHookDescriptor(
        repo.id,
        repo.name,
        runnableHook.triggerName,
        runnableHook.actions,
      );
      entries.push({
        hook,
        request: {
          target: 'workspace-repo',
          triggerName: runnableHook.triggerName,
          workspaceId: project.id,
          worktreeId,
          repoId: repo.id,
        },
      });
    }
  }

  return entries;
}

export function countConfiguredHooks(
  projects: SidebarItem[],
  projectId: string | null,
  worktreeId: string | null,
  appliedProjectWorktreeHooks: AppliedProjectWorktreeHooks,
): number {
  if (!projectId) return 0;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return 0;
  if (project.type === 'cowork') return 0;
  const wtOverrides = worktreeId
    ? project.worktreeEffective?.[worktreeId]
    : undefined;

  if (project.type === 'single-repo') {
    if (!worktreeId) return 0;
    const effectiveHooks = getDisplayHooks(
      getSingleRepoWorktreeEffectiveHooks(
        project,
        worktreeId,
        appliedProjectWorktreeHooks,
      ),
      wtOverrides?.effectiveHooks,
      project.hooks,
    );
    return listRunnableHooks(effectiveHooks).length;
  }

  let count = hasWorkspaceRootHooks(project, wtOverrides)
    ? listRunnableHooks(
        getDisplayHooks(
          project.effectiveHooks,
          wtOverrides?.effectiveHooks,
          project.hooks,
        ),
      ).length
    : 0;
  for (const repo of project.repos) {
    count += listRunnableHooks(
      getDisplayHooks(
        repo.effectiveHooks,
        wtOverrides?.repos?.[repo.id]?.effectiveHooks,
        repo.hooks,
      ),
    ).length;
  }
  return count;
}
