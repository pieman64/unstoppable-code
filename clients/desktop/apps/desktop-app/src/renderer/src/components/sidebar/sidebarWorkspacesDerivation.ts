import type {
  SidebarItem,
  SidebarSortMode,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { hasVisibleWorkspaceContent } from '@canopy/desktop-shared/lib/workspace-visibility';
import {
  computeWorktreeUiStatus,
  type WorktreeUiStatus,
} from '@/lib/worktree-status';
import { orderSidebarWorkspaces } from '@/lib/sidebar-ordering';
import { isWorkspaceInContext } from '@/lib/automationContextScope';

/**
 * Filter option describing a single workspace for the sidebar filter dropdown.
 * Mirrors the `filterWorkspaceOptions` shape derived in `WorktreeManager`.
 */
export interface SidebarWorkspaceFilterOption {
  id: string;
  name: string;
  color: string;
  kind: 'single-repo' | 'multi-repo' | 'cowork';
  temporary?: boolean;
  repoPath?: string;
  worktreeCount: number;
}

/**
 * Partition of the sorted workspace list into the always-visible list and the
 * collapsed "Hidden Projects" group, matching `WorktreeManager`'s
 * `visibleProjects` / `hiddenProjects` derivations exactly.
 */
export interface SidebarWorkspacePartition {
  sortedProjects: SidebarItem[];
  visibleProjects: SidebarItem[];
  hiddenProjects: SidebarItem[];
}

/** Sort a workspace list ascending by `order`, without mutating the input. */
export function sortProjectsByOrder(projects: SidebarItem[]): SidebarItem[] {
  return [...projects].sort((left, right) => left.order - right.order);
}

/** Ordering inputs for the top-level Projects section (CAN-1074). */
export interface SidebarWorkspaceOrderingOptions {
  /** Section sort mode from `PreferencesData.sidebarProjectSortMode`. */
  sortMode?: SidebarSortMode;
  /**
   * Workspace id -> epoch-ms activity watermark, for workspaces that carry no
   * intrinsic timestamp (cowork). See `workspaceRecencyMs`.
   */
  recencyOverrides?: ReadonlyMap<string, number>;
}

/**
 * Apply the persisted `order` as the manual baseline, then layer pin + recency
 * ordering on top. Pinned workspaces always lead, and the unpinned tail is
 * recency-sorted unless the section is in manual mode.
 */
export function sortProjectsForSidebar(
  projects: SidebarItem[],
  options?: SidebarWorkspaceOrderingOptions,
): SidebarItem[] {
  return orderSidebarWorkspaces(
    sortProjectsByOrder(projects),
    options?.sortMode,
    options?.recencyOverrides,
  );
}

/**
 * Derive the visible/hidden workspace partition. Parity with `WorktreeManager`:
 * - A workspace whose id is in `hiddenWorkspaceIds` is fully filtered out of
 *   both lists.
 * - A workspace with `alwaysShow !== false` is always visible.
 * - A workspace with `alwaysShow === false` is visible only while it has at
 *   least one non-hidden worktree; otherwise it drops into the hidden group.
 *
 * Ordering is pin-then-mode (CAN-1074); pass `ordering` to opt into the
 * `'last-updated'` mode (the default is `'manual'`) or to supply cowork
 * recency.
 */
export function partitionSidebarWorkspaces(
  projects: SidebarItem[],
  hiddenWorkspaceIds: readonly string[],
  ordering?: SidebarWorkspaceOrderingOptions,
  /**
   * Selected Personal/organization context (CAN-2954). Rows owned by another
   * context are dropped from every list before the hidden filter applies;
   * omit to keep the unscoped list.
   */
  context?: WorkspaceContext,
  /** Existing Personal checkouts linked to this organization’s catalog. */
  linkedPersonalWorkspaceIds: readonly string[] = [],
): SidebarWorkspacePartition {
  const linkedPersonalIds = new Set(linkedPersonalWorkspaceIds);
  const sortedProjects = sortProjectsForSidebar(
    projects.filter((project) =>
      isWorkspaceInContext(project, context, linkedPersonalIds),
    ),
    ordering,
  );
  const hiddenWorkspaceIdSet = new Set(hiddenWorkspaceIds);

  const visibleProjects = sortedProjects.filter((project) => {
    if (hiddenWorkspaceIdSet.has(project.id)) {
      return false;
    }
    if (project.alwaysShow !== false) {
      return true;
    }
    return hasVisibleWorkspaceContent(project);
  });

  const hiddenProjects = sortedProjects.filter(
    (project) =>
      project.alwaysShow === false &&
      !hasVisibleWorkspaceContent(project) &&
      !hiddenWorkspaceIdSet.has(project.id),
  );

  return { sortedProjects, visibleProjects, hiddenProjects };
}

/**
 * Build the filter-dropdown option list from the sorted workspace list, matching
 * `WorktreeManager`'s `filterWorkspaceOptions` derivation.
 */
export function buildSidebarWorkspaceFilterOptions(
  sortedProjects: SidebarItem[],
): SidebarWorkspaceFilterOption[] {
  return sortedProjects.map((project) => ({
    id: project.id,
    name: project.name,
    color: project.color,
    kind: project.type,
    temporary: project.type === 'multi-repo' ? project.temporary : undefined,
    repoPath: project.type === 'single-repo' ? project.repoPath : undefined,
    worktreeCount: project.type === 'cowork' ? 0 : project.worktrees.length,
  }));
}

/** Per-worktree activity key sets consumed by {@link buildWorktreeStatusMap}. */
export interface WorktreeStatusKeySets {
  unreadWorktreeKeys: Set<string>;
  unseenPipelineWorktreeKeys: Set<string>;
  unseenFailedPipelineWorktreeKeys: Set<string>;
  streamingWorktreeKeys: Set<string>;
  pipelineRunningWorktreeKeys: Set<string>;
  awaitingApprovalKeys: Set<string>;
  pipelinePausedWorktreeKeys: Set<string>;
}

/**
 * Compute the `${projectId}/${worktreeId}` → UI-status map over the given
 * projects, matching `WorktreeManager`'s `worktreeStatusMap` derivation. The
 * caller passes the union of visible + hidden projects so hidden-group rows
 * still resolve a status.
 */
export function buildWorktreeStatusMap(
  projects: SidebarItem[],
  keys: WorktreeStatusKeySets,
): Map<string, WorktreeUiStatus> {
  const map = new Map<string, WorktreeUiStatus>();
  for (const project of projects) {
    if (project.type === 'cowork') {
      continue;
    }

    for (const worktree of project.worktrees) {
      const key = `${project.id}/${worktree.id}`;
      const isDone = worktree.status === 'done';
      const hasUnread =
        keys.unreadWorktreeKeys.has(key) ||
        keys.unseenPipelineWorktreeKeys.has(key) ||
        keys.unseenFailedPipelineWorktreeKeys.has(key);
      const isWorking =
        keys.streamingWorktreeKeys.has(key) ||
        keys.pipelineRunningWorktreeKeys.has(key);
      const isPlanning =
        keys.awaitingApprovalKeys.has(key) ||
        keys.pipelinePausedWorktreeKeys.has(key);
      map.set(
        key,
        computeWorktreeUiStatus({ isDone, hasUnread, isWorking, isPlanning }),
      );
    }
  }
  return map;
}
