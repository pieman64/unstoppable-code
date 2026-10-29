import { useCallback, useMemo } from 'react';
import type { ScriptActionsAddReceipt } from '@canopy/protocol/script-actions';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { ReservedScriptShortcut } from '@canopy/ui-app/script-actions';
import { rendererShortcutPlatform } from '@/lib/globalFocusShortcut';
import { useGlobalFocusShortcutStore } from '@/stores/globalFocusShortcutStore';
import { useProjectsStore } from '@/stores/projectsStore';

/** Display name of one repository in a desktop project. */
export function desktopRepositoryName(
  projects: readonly SidebarItem[],
  projectId: string,
  repoId: string,
): string | undefined {
  const project = projects.find((entry) => entry.id === projectId);
  if (project === undefined || project.type === 'cowork') return undefined;
  if (project.type === 'single-repo')
    return repoId === SINGLE_REPO_USAGE_REPO_ID ? project.name : undefined;
  if (repoId === WORKSPACE_ROOT_REPO_ID) return project.name;
  return project.repos.find((repo) => repo.id === repoId)?.name;
}

/**
 * The name a post-add notice uses: the repository when the operation added
 * one, otherwise the project, otherwise null ("this project").
 */
export function scriptActionsReceiptTargetName(
  projects: readonly SidebarItem[],
  receipt: Pick<ScriptActionsAddReceipt, 'projectId' | 'repoIds'>,
): string | null {
  const [onlyRepo, ...others] = receipt.repoIds;
  if (onlyRepo !== undefined && others.length === 0) {
    const repo = desktopRepositoryName(projects, receipt.projectId, onlyRepo);
    if (repo !== undefined) return repo;
  }
  return projects.find((entry) => entry.id === receipt.projectId)?.name ?? null;
}

/**
 * The worktree a notice's Review opens: the receipt's own, else the selected
 * worktree in that project, else the project's only worktree. Null when the
 * user has to choose one first.
 */
export function scriptActionsReviewWorktreeId(
  projects: readonly SidebarItem[],
  selected: { readonly projectId: string; readonly worktreeId: string } | null,
  receipt: Pick<ScriptActionsAddReceipt, 'projectId' | 'worktreeId'>,
): string | null {
  if (receipt.worktreeId !== null) return receipt.worktreeId;
  if (selected !== null && selected.projectId === receipt.projectId)
    return selected.worktreeId;
  const project = projects.find((entry) => entry.id === receipt.projectId);
  if (project === undefined || project.type === 'cowork') return null;
  const [only, ...others] = project.worktrees;
  return only !== undefined && others.length === 0 ? only.id : null;
}

export interface DesktopScriptActionsReviewProps {
  readonly shortcutPlatform: ReturnType<typeof rendererShortcutPlatform>;
  readonly reservedShortcuts: readonly ReservedScriptShortcut[];
  readonly resolveRepositoryName: (
    projectId: string,
    repoId: string,
  ) => string | undefined;
}

/**
 * The desktop's platform-dependent review inputs. The global focus shortcut
 * is reserved once its status has loaded; the service checks it regardless.
 */
export function useDesktopScriptActionsReviewProps(): DesktopScriptActionsReviewProps {
  const focusShortcut = useGlobalFocusShortcutStore((state) => state.status);
  const shortcutPlatform =
    focusShortcut?.platform ?? rendererShortcutPlatform();
  const reservedShortcuts = useMemo<readonly ReservedScriptShortcut[]>(
    () =>
      focusShortcut?.enabled
        ? [{ accelerator: focusShortcut.accelerator, title: 'Focus app' }]
        : [],
    [focusShortcut?.accelerator, focusShortcut?.enabled],
  );
  const resolveRepositoryName = useCallback(
    (projectId: string, repoId: string): string | undefined =>
      desktopRepositoryName(
        useProjectsStore.getState().projects,
        projectId,
        repoId,
      ),
    [],
  );
  return { shortcutPlatform, reservedShortcuts, resolveRepositoryName };
}
