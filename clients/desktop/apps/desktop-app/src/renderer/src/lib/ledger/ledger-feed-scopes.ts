import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import {
  APP_ADVISOR_PROJECT_ID,
  type CoworkWorkEntryMeta,
  type SidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { LedgerFeedScopeOption } from '@canopy/ui-app/ledger';
import { getWorkspaceDisplayName } from '@/lib/workspaceDisplayName';
import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';

/*
 * How the Feed names this device's work: a project and its worktree or task,
 * as the sidebar does. Only this device's names; a row from another device
 * shows its device instead.
 */

/** What the Feed reads names from. */
export interface LedgerFeedScopeSources {
  readonly projects: readonly SidebarItem[];
  /** Each Cowork project's Work Entries, by project. */
  readonly coworkEntries: Readonly<
    Record<string, readonly CoworkWorkEntryMeta[]>
  >;
}

function worktreeName(worktree: WorktreeData): string {
  const label = worktree.label?.trim() ?? '';
  return label.length > 0
    ? label
    : getWorktreeBranchDisplayName({
        rawBranch: worktree.branchName,
        worktreeId: worktree.id,
        hasMultipleBranches: false,
        getBranchDisplayName: (branchName) => branchName,
      });
}

/** A scope's project and task, or null when this device does not list it. */
export function describeLedgerScope(
  scope: LedgerViewScope,
  sources: LedgerFeedScopeSources,
): string | null {
  if (scope.projectId === APP_ADVISOR_PROJECT_ID) return 'Advisor';
  const project = sources.projects.find((item) => item.id === scope.projectId);
  if (project === undefined) return null;
  const projectName = getWorkspaceDisplayName(project);
  if (project.type === 'cowork') {
    const entry = sources.coworkEntries[project.id]?.find(
      (candidate) => candidate.id === scope.worktreeId,
    );
    return entry === undefined
      ? projectName
      : `${projectName} · ${entry.title}`;
  }
  const worktree = project.worktrees.find(
    (candidate) => candidate.id === scope.worktreeId,
  );
  return worktree === undefined
    ? projectName
    : `${projectName} · ${worktreeName(worktree)}`;
}

/** The worktrees and tasks "Add entry" offers, in sidebar order. */
export function ledgerFeedAddableScopes(
  sources: LedgerFeedScopeSources,
): LedgerFeedScopeOption[] {
  const options: LedgerFeedScopeOption[] = [];
  for (const project of sources.projects) {
    const projectName = getWorkspaceDisplayName(project);
    if (project.type === 'cowork') {
      for (const entry of sources.coworkEntries[project.id] ?? []) {
        options.push({
          scope: { projectId: project.id, worktreeId: entry.id },
          label: entry.title,
          project: projectName,
        });
      }
      continue;
    }
    for (const worktree of project.worktrees) {
      options.push({
        scope: { projectId: project.id, worktreeId: worktree.id },
        label: worktreeName(worktree),
        project: projectName,
      });
    }
  }
  return options;
}
