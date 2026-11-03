import type {
  MultiRepoSidebarItem,
  SidebarItem,
  SingleRepoSidebarItem,
  WorktreeCreationIdentity,
  WorktreeData,
  WorktreeHealthIssue,
} from '../types';

export interface WorktreeRecordTarget {
  workspaceId: string;
  worktreeId: string;
}

/** A worktree incarnation: a different `createdAt` is another worktree. */
export type WorktreeIncarnation = Pick<WorktreeData, 'id' | 'createdAt'>;

// ---------------------------------------------------------------------------
// W6a1 (CAN-4815): workspace-service staging (CAN-3806, CAN-3812, CAN-3813):
// a find-or-create addition, and a create's or an import's publication
//
// D9 internal decisions: no key, client revision or receipt. Each applies
// through the whole-sidebar writer the records used, unchanged: its index
// merge, unreadable-project preservation and post-commit registries stay that
// writer's, shared with Cowork deletion. A create or import commits in its
// reserved creation boundary step, a scoped addition in its caller's step; an
// unscoped addition commits each write on its own, as before. Admission, id
// allocation and the effects marker stay host steps. Items carry host paths.
// ---------------------------------------------------------------------------

/**
 * Adds a find-or-create destination. A `workspace` scope writes only this
 * workspace's files and keeps every other entry, as its caller's step locks
 * only them; a `sidebar` scope rewrites the sidebar read in the workspace
 * mutation queue, keeping `preserveWorkspaceIds` as persisted.
 */
export interface WorkspaceAdditionDecision {
  kind: 'workspace.add';
  item: SidebarItem;
  scope:
    | { kind: 'workspace' }
    | {
        kind: 'sidebar';
        previousItems: SidebarItem[];
        preserveWorkspaceIds: string[];
      };
}

/**
 * Publishes a created or imported repository project: only the addition,
 * binding its owner and keeping every other entry.
 */
export interface WorkspaceCreationPublishDecision {
  kind: 'workspace.create.publish';
  item: SidebarItem;
}

/**
 * Publishes an imported multi-repo project and its new member projects
 * together, keeping every other entry and every owner binding on disk.
 */
export interface WorkspaceImportPublishDecision {
  kind: 'workspace.import.publish';
  workspace: MultiRepoSidebarItem;
  childWorkspaces: SingleRepoSidebarItem[];
}

export type WorkspaceCreationDecision =
  | WorkspaceCreationPublishDecision
  | WorkspaceImportPublishDecision;

/** The whole-sidebar write a W6a1 decision makes. */
export interface WorkspaceSidebarWrite {
  items: SidebarItem[];
  options: {
    preserveEmptyTemporary?: false;
    preserveUnmentionedWorkspaceIds?: true;
    preserveWorkspaceIds?: string[];
    replaceOwnershipWorkspaceIds?: string[];
  };
}

// W6b (CAN-4947): worktree creation records (CAN-3810).
// The reservation commits in `core.worktree.create`'s reservation step, under
// its optional expected worktrees collection revision. The setup records
// commit on their own, except a keyed needs-repair retention, which commits
// with its receipt; a created outcome still ends with the receipt-only
// decision. The host keeps admission, the metadata reservation, the effects
// markers, Git, cancellation, rollback triggers and every receipt.

/**
 * Leads the list with a reserved row. An id already listed is a collision and
 * writes nothing; a listed branch or checkout path is refused.
 */
export interface WorktreeCreationReservationDecision {
  kind: 'worktree.create.reserve';
  /** The `git-pending` row; its checkouts carry host paths. */
  worktree: WorktreeData;
  sidebarItemGroupId?: string;
}

export interface WorktreeCreationReservationPreconditions {
  /** The worktrees collection revision the reservation expects. */
  expectedRevision?: number;
}

export interface WorktreeCreationReservationOutcome {
  status: 'reserved' | 'collision';
}

/** A reserved row's incarnation: the setup reference of its create. */
export interface ReservedWorktreeTarget extends WorktreeRecordTarget {
  createdAt: string;
}

/** Records a promoted checkout's branch and base, completing its creation. */
export type WorktreeCreationPromoteDecision =
  | {
      kind: 'worktree.create.promote';
      workspaceKind: 'single-repo';
      branchName: string;
      /** Absent clears the row's base. */
      trackedBaseBranch?: string;
    }
  | {
      kind: 'worktree.create.promote';
      workspaceKind: 'multi-repo';
      branchName: string;
      /** Absent clears the row's bases. */
      trackedRepoBaseBranches?: Record<string, string>;
    };

/**
 * The records a create's setup makes on its reserved row. There, each refuses
 * a changed branch another row holds.
 */
export type WorktreeCreationSetupDecision =
  | {
      kind: 'worktree.create.phase';
      /** Absent keeps the recorded phase. */
      phase?: WorktreeCreationIdentity['phase'];
      recoveryRequired: boolean;
      healthIssue?: WorktreeHealthIssue;
    }
  | { kind: 'worktree.create.branch'; branchName: string }
  | WorktreeCreationPromoteDecision;

/** Removes a reserved row's incarnation, applying the requested order. */
export interface WorktreeCreationReservationRemovalDecision {
  kind: 'worktree.create.reservation.remove';
  remainingWorktreeOrder?: readonly string[];
  /** Applies the order only when the remaining rows still read in this order. */
  expectedRemainingWorktreeOrder?: readonly string[];
}
