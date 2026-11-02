import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WorktreeRowProps } from '@canopy/ui-shared/components';
import { orderWorktreesForSidebar } from './sidebar-model';
import type { SidebarSortMode } from './sidebar/sidebar-ordering';
import {
  compareWorkspaces,
  compareWorktrees,
  deriveWorktreeUiStatus,
  isTreeLayout,
  type SnapshotWorkspace,
  type SnapshotWorktree,
} from './worktree-status';

/**
 * Minimal structural snapshot the sections layer consumes. A host may pass
 * its full `SessionViewModel`, but browser-local projections that omit
 * unrelated collections (e.g. the web portal's `PortalSessionShellState`
 * without `chatProjects`) satisfy this shape too.
 */
export interface WorkspaceSectionsSnapshot {
  readonly workspaces: readonly SnapshotWorkspace[];
  readonly worktrees: readonly SnapshotWorktree[];
  /**
   * The standalone chats a flat-layout project lists, when the host renders
   * them. Only their ownership and archived state are read: they are a flat
   * project's live content for the `alwaysShow: false` visibility rule.
   */
  readonly standaloneChats?: readonly WorkspaceContentChat[];
  /**
   * Per-chat attention the rows roll up (a waiting question). Optional: a
   * host whose snapshot carries no chat summaries simply gets no roll-up.
   */
  readonly chatSummaries?: readonly WorktreeChatAttentionSummary[];
}

/** The slice of a standalone chat the project visibility rule reads. */
export interface WorkspaceContentChat {
  readonly projectLocalId?: string;
  readonly archived?: boolean;
}

/**
 * The chat-summary fields a worktree row's attention roll-up reads, a
 * structural subset of the wire's `PortalChatSummaryEntity`.
 */
export interface WorktreeChatAttentionSummary {
  readonly workspaceLocalId?: string;
  readonly worktreeLocalId?: string;
  readonly pendingQuestions?: readonly { readonly answered: boolean }[];
}

/** The `${workspaceLocalId}/${worktreeLocalId}` key rows are addressed by. */
export function worktreeRowKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  return `${workspaceLocalId}/${worktreeLocalId}`;
}

/**
 * Worktrees with at least one chat waiting on an unanswered question. The
 * wire carries questions per chat; the row's question dot is per worktree, so
 * every host that ships chat summaries (the portal today) lights it from the
 * same roll-up instead of each inventing one.
 */
export function rollUpPendingQuestionWorktreeKeys(
  summaries: readonly WorktreeChatAttentionSummary[] | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const summary of summaries ?? []) {
    if (!summary.workspaceLocalId || !summary.worktreeLocalId) continue;
    if (summary.pendingQuestions?.some((question) => !question.answered)) {
      keys.add(
        worktreeRowKey(summary.workspaceLocalId, summary.worktreeLocalId),
      );
    }
  }
  return keys;
}

export interface WorkspaceSectionsPartition {
  readonly visible: SnapshotWorkspace[];
  readonly hidden: SnapshotWorkspace[];
}

export interface WorktreeSectionsPartition {
  readonly visible: SnapshotWorktree[];
  readonly hidden: SnapshotWorktree[];
}

export type WorktreeRuntimeProjection = Pick<
  WorktreeRowProps,
  | 'uiStatus'
  | 'isStreaming'
  | 'backgroundTasks'
  | 'isRunningRun'
  | 'isDiscovering'
  | 'pipelineStatus'
  | 'terminalStatus'
  | 'scriptStatus'
  | 'hookStatus'
  | 'splitStatus'
  | 'splitStatusMessage'
  | 'awaitingApproval'
  | 'hasPendingQuestion'
  | 'hasUnread'
  | 'healthIssue'
  | 'setupPhase'
  | 'diffStats'
  | 'runtimeState'
>;

/**
 * Whether this workspace renders a worktree tree. Named for LAYOUT, not for
 * repo-backing: a cloud workspace is repoless yet tree-shaped, so the old
 * `isGitWorkspace`/`type !== 'cowork'` framing described neither axis honestly
 * (REG-2819).
 */
export function isTreeWorkspace(workspace: SnapshotWorkspace): boolean {
  return isTreeLayout(workspace);
}

export { compareWorkspaces, compareWorktrees };

/**
 * Context scoping (CAN-2954, plan chapter 03): Personal lists rows with no
 * owner or a Personal owner; an organization context lists its owned rows
 * plus Personal checkouts explicitly linked by the host. No context means no
 * scoping, so hosts that predate contexts keep today's list.
 */
export function snapshotWorkspaceMatchesContext(
  workspace: Pick<SnapshotWorkspace, 'owner'> &
    Partial<Pick<SnapshotWorkspace, 'localId'>>,
  context: WorkspaceContext | undefined,
  linkedPersonalWorkspaceIds: readonly string[] = [],
): boolean {
  if (context === undefined) return true;
  const owner = workspace.owner;
  if (context.kind === 'personal') {
    return owner === undefined || owner.type === 'personal';
  }
  if (owner === undefined || owner.type === 'personal') {
    return (
      workspace.localId !== undefined &&
      linkedPersonalWorkspaceIds.includes(workspace.localId)
    );
  }
  // An org-owned cloud workspace (CAN-3458) has no org project behind it but
  // belongs to the same context as the org's materialized projects.
  return (
    (owner.type === 'organization' || owner.type === 'cloud-organization') &&
    owner.organizationId === context.organizationId
  );
}

export function partitionWorktrees(
  worktrees: readonly SnapshotWorktree[],
  workspaceLocalId: string,
  mode: SidebarSortMode = 'manual',
): WorktreeSectionsPartition {
  const ordered = orderWorktreesForSidebar(
    worktrees.filter(
      (worktree) => worktree.workspaceLocalId === workspaceLocalId,
    ),
    mode,
  );
  return {
    visible: ordered.filter((worktree) => worktree.hidden !== true),
    hidden: ordered.filter((worktree) => worktree.hidden === true),
  };
}

export function partitionWorkspaces(
  workspaces: readonly SnapshotWorkspace[],
  worktrees: readonly SnapshotWorktree[],
  options: {
    /**
     * Admit flat-layout workspaces too. Hosts set this when they can render the
     * standalone-chats projection. Tree-layout workspaces — repo-backed AND
     * cloud — are always admitted regardless.
     */
    readonly includeFlat?: boolean;
    readonly visibleWorkspaceIds?: ReadonlySet<string>;
    /** Scope rows to the selected Personal/organization context. */
    readonly context?: WorkspaceContext;
    /** Personal checkouts linked by the host to the selected organization. */
    readonly linkedPersonalWorkspaceIds?: readonly string[];
    /**
     * Standalone chats, the live content of flat-layout projects. Without
     * them a flat project has no content the rule can see.
     */
    readonly standaloneChats?: readonly WorkspaceContentChat[];
  } = {},
): WorkspaceSectionsPartition {
  const sorted = workspaces
    .filter(
      (workspace) =>
        // Catalog placeholders (CAN-2955) are not workspaces: hosts that want
        // them render a dedicated row from the catalog, never this list.
        workspace.placeholder === undefined &&
        (isTreeWorkspace(workspace) || options.includeFlat === true) &&
        (options.visibleWorkspaceIds === undefined ||
          options.visibleWorkspaceIds.has(workspace.localId)) &&
        snapshotWorkspaceMatchesContext(
          workspace,
          options.context,
          options.linkedPersonalWorkspaceIds,
        ),
    )
    .slice()
    .sort(compareWorkspaces);
  // A project that is not set to always show lists only while it has live
  // content. A tree project's content is its visible worktrees; a flat
  // (desktop Cowork) project has none, so its content is its unarchived chats,
  // the legacy desktop rail's `workEntryCount` rule.
  const flatWorkspacesWithChats = new Set(
    (options.standaloneChats ?? [])
      .filter((chat) => chat.archived !== true)
      .map((chat) => chat.projectLocalId),
  );
  const isVisible = (workspace: SnapshotWorkspace): boolean => {
    if (workspace.hidden === true) return false;
    if (workspace.alwaysShow !== false) return true;
    if (!isTreeWorkspace(workspace)) {
      return flatWorkspacesWithChats.has(workspace.localId);
    }
    return partitionWorktrees(worktrees, workspace.localId).visible.length > 0;
  };
  return {
    visible: sorted.filter(isVisible),
    hidden: sorted.filter((workspace) => !isVisible(workspace)),
  };
}

/**
 * Legacy done fallback: older cached payloads may omit `status` while every
 * repo with a PR reports `merged` — the pre-extraction portal treated that as
 * done and the shared row must keep doing so.
 */
export function isWorktreeDone(worktree: SnapshotWorktree): boolean {
  if (worktree.status === 'done') return true;
  if (worktree.status !== undefined) return false;
  const repos = worktree.lastKnownPrStatus?.repos ?? [];
  const reposWithPrs = repos.filter((repo) => repo.status !== null);
  return (
    reposWithPrs.length > 0 &&
    reposWithPrs.every((repo) => repo.status?.state === 'merged')
  );
}

/** Row state rolled up from other snapshot collections (chat summaries). */
export interface WorktreeRuntimeRollups {
  readonly hasPendingQuestion?: boolean;
  /**
   * The row's space is muted (`isSpaceNotificationMuted`): its blue-dot
   * sources, unread chats and an unseen pipeline success, are masked before
   * anything derives from them. Orange and red states and live work still show.
   */
  readonly spaceMuted?: boolean;
}

/**
 * Drops a muted space's blue-dot sources; the snapshot itself is untouched.
 * A host's live row overrides get the same mask in `WorkspacesSidebarSections`
 * (`maskMutedWorktreeRowOverrides`); a new blue-dot source needs both.
 */
function maskMutedSpace(
  worktree: SnapshotWorktree,
  spaceMuted: boolean,
): SnapshotWorktree {
  if (!spaceMuted) return worktree;
  return {
    ...worktree,
    hasUnread: undefined,
    pipelineStatus:
      worktree.pipelineStatus === 'unseen'
        ? undefined
        : worktree.pipelineStatus,
  };
}

export function projectWorktreeRuntime(
  snapshotWorktree: SnapshotWorktree,
  rollups: WorktreeRuntimeRollups = {},
): WorktreeRuntimeProjection {
  const worktree = maskMutedSpace(
    snapshotWorktree,
    rollups.spaceMuted === true,
  );
  const done = isWorktreeDone(worktree);
  return {
    uiStatus: done ? 'done' : deriveWorktreeUiStatus(worktree),
    isStreaming: worktree.isStreaming,
    backgroundTasks: worktree.backgroundTasks,
    isRunningRun: worktree.isRunningRun ?? worktree.busy,
    isDiscovering: worktree.isDiscovering,
    pipelineStatus: worktree.pipelineStatus,
    terminalStatus: worktree.terminalStatus,
    scriptStatus: worktree.scriptStatus,
    hookStatus: worktree.hookStatus,
    splitStatus:
      worktree.splitPrStatus === 'ready'
        ? 'review'
        : worktree.splitPrStatus === 'completed'
          ? 'done'
          : worktree.splitPrStatus
            ? 'active'
            : undefined,
    splitStatusMessage: worktree.splitPrStatusMessage,
    awaitingApproval: worktree.awaitingApproval,
    hasPendingQuestion: rollups.hasPendingQuestion === true,
    hasUnread: worktree.hasUnread,
    healthIssue: worktree.healthIssue,
    setupPhase: worktree.setupPhase,
    diffStats: worktree.diffStats,
    runtimeState: done ? 'done' : undefined,
  };
}

export function workspaceWorktreeIds(
  worktrees: readonly SnapshotWorktree[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const ids = new Map<string, Set<string>>();
  for (const worktree of worktrees) {
    const workspaceIds = ids.get(worktree.workspaceLocalId) ?? new Set();
    workspaceIds.add(worktree.localId);
    ids.set(worktree.workspaceLocalId, workspaceIds);
  }
  return ids;
}

/**
 * Resolves pending creates from authoritative snapshots without a request
 * correlation id. A workspace remains pending until at least one local id not
 * present at dispatch appears; one addition is selectable by the caller, while
 * multiple additions are deliberately treated as ambiguous.
 */
export function pendingWorkspaceIdsAfterSnapshot(
  pendingBaselines: ReadonlyMap<string, ReadonlySet<string>>,
  worktrees: readonly SnapshotWorktree[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const remaining = new Map<string, ReadonlySet<string>>();
  let resolved = false;
  pendingBaselines.forEach((baseline, workspaceLocalId) => {
    const addedIds = newWorktreeIdsAfterSnapshot(
      baseline,
      workspaceLocalId,
      worktrees,
    );
    if (addedIds.length === 0) {
      remaining.set(workspaceLocalId, baseline);
    } else {
      resolved = true;
    }
  });
  // INVARIANT: return the ORIGINAL map reference when nothing resolved.
  // The consuming effect lists pendingBaselines in its dependency array; a
  // fresh Map on the unchanged path would commit a new reference every
  // snapshot and drive an infinite re-render/effect loop.
  return resolved ? remaining : pendingBaselines;
}

export function newWorktreeIdsAfterSnapshot(
  baseline: ReadonlySet<string>,
  workspaceLocalId: string,
  worktrees: readonly SnapshotWorktree[],
): readonly string[] {
  return worktrees
    .filter(
      (worktree) =>
        worktree.workspaceLocalId === workspaceLocalId &&
        !baseline.has(worktree.localId),
    )
    .map((worktree) => worktree.localId);
}
