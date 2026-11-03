import type { WorktreeData } from '../types';
import type {
  WorkspaceAdditionDecision,
  WorkspaceCreationDecision,
  WorkspaceSidebarWrite,
  WorktreeCreationReservationDecision,
  WorktreeCreationReservationOutcome,
  WorktreeCreationSetupDecision,
  WorktreeIncarnation,
} from './worktree-record-decisions';

// ---------------------------------------------------------------------------
// workspace-service staging (W6a1)
// ---------------------------------------------------------------------------

/**
 * The sidebar write of a find-or-create addition. Only the addition binds an
 * owner. A scoped write reserved only this workspace's files, so it keeps
 * every other entry and preserves no other empty temporary workspace, which
 * would read and write files outside its locks.
 */
export function workspaceAdditionWriteFor(
  decision: WorkspaceAdditionDecision,
): WorkspaceSidebarWrite {
  const replaceOwnershipWorkspaceIds = [decision.item.id];
  return decision.scope.kind === 'workspace'
    ? {
        items: [decision.item],
        options: {
          preserveEmptyTemporary: false,
          preserveUnmentionedWorkspaceIds: true,
          replaceOwnershipWorkspaceIds,
        },
      }
    : {
        items: [...decision.scope.previousItems, decision.item],
        options: {
          preserveWorkspaceIds: decision.scope.preserveWorkspaceIds,
          replaceOwnershipWorkspaceIds,
        },
      };
}

/**
 * The addition-only sidebar write of a publication, so observer edits made
 * during provisioning survive. A create binds its owner; an import's projects
 * keep the bindings on disk.
 */
export function workspaceCreationWriteFor(
  decision: WorkspaceCreationDecision,
): WorkspaceSidebarWrite {
  switch (decision.kind) {
    case 'workspace.create.publish':
      return {
        items: [decision.item],
        options: {
          preserveEmptyTemporary: false,
          preserveUnmentionedWorkspaceIds: true,
          replaceOwnershipWorkspaceIds: [decision.item.id],
        },
      };
    case 'workspace.import.publish':
      return {
        items: [decision.workspace, ...decision.childWorkspaces],
        options: {
          preserveEmptyTemporary: false,
          preserveUnmentionedWorkspaceIds: true,
        },
      };
  }
}

/** The workspaces a publication writes, whose manifests and lists its creation step locks. */
export function workspaceCreationIds(
  decision: WorkspaceCreationDecision,
): string[] {
  return workspaceCreationWriteFor(decision).items.map((item) => item.id);
}

// W6b (CAN-4947): pure worktree creation record apply (CAN-3810). A refusal
// is returned for the port to throw inside its locked update, before it writes.
export type WorktreeCreationRecordRefusal =
  | { reason: 'branch-reserved'; branchName: string }
  | { reason: 'checkout-reserved' };

export function applyWorktreeCreationReservationTo(
  rows: WorktreeData[],
  decision: WorktreeCreationReservationDecision,
):
  | {
      worktrees: WorktreeData[];
      status: WorktreeCreationReservationOutcome['status'];
    }
  | { refusal: WorktreeCreationRecordRefusal } {
  const { worktree } = decision;
  if (rows.some((entry) => entry.id === worktree.id))
    return { worktrees: rows, status: 'collision' };
  if (rows.some((entry) => entry.branchName === worktree.branchName))
    return {
      refusal: { reason: 'branch-reserved', branchName: worktree.branchName },
    };
  const paths = new Set(
    worktree.creation?.checkouts.map((checkout) => checkout.checkoutPath),
  );
  if (
    rows.some((entry) =>
      entry.creation?.checkouts.some((checkout) =>
        paths.has(checkout.checkoutPath),
      ),
    )
  )
    return { refusal: { reason: 'checkout-reserved' } };
  // New worktrees lead the manual order, so the one just created sits at the
  // top of its project without recency reordering the rest.
  return { worktrees: [worktree, ...rows], status: 'reserved' };
}

export function applyWorktreeCreationSetupTo(
  row: WorktreeData,
  decision: WorktreeCreationSetupDecision,
): WorktreeData {
  switch (decision.kind) {
    case 'worktree.create.phase':
      return {
        ...row,
        ...(row.creation
          ? {
              creation: {
                ...row.creation,
                state: decision.recoveryRequired
                  ? 'recovery-required'
                  : row.creation.state,
                phase: decision.phase ?? row.creation.phase,
              },
            }
          : {}),
        ...(decision.healthIssue ? { healthIssue: decision.healthIssue } : {}),
      };
    case 'worktree.create.branch':
      return { ...row, branchName: decision.branchName };
    case 'worktree.create.promote':
      return {
        ...row,
        branchName: decision.branchName,
        ...(decision.workspaceKind === 'single-repo'
          ? { trackedBaseBranch: decision.trackedBaseBranch }
          : { trackedRepoBaseBranches: decision.trackedRepoBaseBranches }),
        setupPhase: 'git-ready',
        ...(row.creation
          ? {
              creation: {
                ...row.creation,
                state: 'complete',
                phase: 'git-ready',
              },
            }
          : {}),
      };
  }
}

/**
 * Applies a setup record to the reserved incarnation only, keeping every other
 * row. A changed branch another row holds is refused.
 */
export function applyReservedWorktreeRecordTo(
  rows: WorktreeData[],
  reserved: WorktreeIncarnation,
  decision: WorktreeCreationSetupDecision,
):
  | { worktrees: WorktreeData[]; updated: boolean }
  | { refusal: WorktreeCreationRecordRefusal } {
  let updated = false;
  // Always a new list: the record writes even when its incarnation is gone.
  const worktrees: WorktreeData[] = [];
  for (const row of rows) {
    if (row.id !== reserved.id || row.createdAt !== reserved.createdAt) {
      worktrees.push(row);
      continue;
    }
    const next = applyWorktreeCreationSetupTo(row, decision);
    if (
      next.branchName !== row.branchName &&
      rows.some(
        (entry) => entry.id !== row.id && entry.branchName === next.branchName,
      )
    )
      return {
        refusal: { reason: 'branch-reserved', branchName: next.branchName },
      };
    updated = true;
    worktrees.push(next);
  }
  return { worktrees, updated };
}

export function removesReservedWorktree(
  row: WorktreeData,
  reserved: WorktreeIncarnation,
): boolean {
  return row.id === reserved.id && row.createdAt === reserved.createdAt;
}
