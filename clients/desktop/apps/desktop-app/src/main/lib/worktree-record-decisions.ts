import type {
  AdhocMultiRepoTransitionSource,
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  DependentBaseBranchUpdate,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
  WorkspaceRepoData,
  WorktreeChatBadgesSummary,
  WorktreeCompatibilitySymlink,
  WorktreeData,
  WorktreeDiscovery,
  WorktreeHealthIssue,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types';

/**
 * The decisions the W5 record functions (CAN-3820, CAN-3821, CAN-3822) apply
 * under the worktree list lock, the decisions the composition records
 * (CAN-3823) apply under the list, manifest and index locks (W6d1), the
 * ownership, seed, Cowork and seen records' decisions (W5c2), and the port
 * that applies them (W6-0).
 *
 * A decision is plain data: it survives JSON serialization and carries no
 * closure. It is host-local, not a portable DTO: `health`, both
 * `recovery.expose-*` kinds and the composition kinds naming repositories or
 * `sourceRepoPath` carry host paths. Each record function admits its request
 * on the host before building one; the decision itself is applied without
 * further validation. They are D9 internal decisions: no key, client
 * revision or idempotency guarantee. A composition decision commits in its
 * caller's W5 boundary step when there is one; otherwise its writer commits
 * it on its own, as before.
 */

export interface WorktreeRecordTarget {
  workspaceId: string;
  worktreeId: string;
}

/**
 * The caller of a badge record, which decides the merge: a chat commit
 * replaces the summary with the one derived from the committed chats; the
 * launch backfill only fills a missing summary or adds `chatName` to an older
 * one, so it never replaces badges a live commit wrote after its read.
 */
export type WorktreeChatBadgesSource = 'chat_commit' | 'launch_backfill';

/**
 * `health-check` is the user's explicit retry (`worktree:health-check`): a
 * broken result always refreshes the stored issue and its `checkedAt`.
 * `diff-stats` is the background check of `worktree:diff-stats-batch`: an
 * issue equal to the stored one keeps the stored `checkedAt` and writes
 * nothing.
 */
export type WorktreeHealthRecordSource = 'health-check' | 'diff-stats';

export interface WorktreeActivityWatermarkDecision {
  kind: 'activity.watermark';
  /** A normalized ISO timestamp. */
  touchedAt: string;
}

export interface WorktreeChatBadgesDecision {
  kind: 'chatBadges';
  source: WorktreeChatBadgesSource;
  summary: WorktreeChatBadgesSummary;
}

export type WorktreeGitRowDecision =
  | {
      kind: 'git.branch';
      /** Trimmed. */
      branchName: string;
      /** A root or single-repository change also moves the sidebar branch. */
      updatesSidebarBranch: boolean;
    }
  | { kind: 'git.pr-status'; status: WorktreePrStatus | null }
  | { kind: 'git.split-child-grouping' }
  | {
      kind: 'git.split-original-retarget';
      /** Trimmed. */
      branchName: string;
      /** Trimmed. */
      trackedBaseBranch: string;
    };

export interface WorktreeHealthDecision {
  kind: 'health';
  source: WorktreeHealthRecordSource;
  /** Null when the worktree validated healthy. Carries host paths. */
  issue: WorktreeHealthIssue | null;
}

export type WorktreeDiscoveryDecision =
  | { kind: 'discovery.environment'; discovery: WorktreeDiscovery }
  | { kind: 'discovery.branch-prompt'; sent: boolean };

/**
 * Each names the row incarnation launch observed by its `createdAt`; a
 * different incarnation is `not-found`.
 */
export type WorktreeRecoveryDecision =
  | { kind: 'recovery.promote-pending'; createdAt: string; branchName: string }
  | {
      kind: 'recovery.complete-source-root-repair';
      createdAt: string;
      operationId: string;
    }
  | {
      kind: 'recovery.expose-create-reservation';
      createdAt: string;
      operationId: string;
      /** A host path. */
      worktreePath: string;
    }
  | {
      kind: 'recovery.expose-split-reservation';
      createdAt: string;
      /** A host path. */
      worktreePath: string;
    };

/** The row decisions whose outcome is a `WorktreeRecordOutcome`. */
export type WorktreeRecordRowDecision =
  | WorktreeGitRowDecision
  | WorktreeHealthDecision
  | WorktreeDiscoveryDecision
  | WorktreeRecoveryDecision;

/** A decision that changes at most one row. */
export type WorktreeRowDecision =
  | WorktreeActivityWatermarkDecision
  | WorktreeChatBadgesDecision
  | WorktreeRecordRowDecision;

export interface WorktreeAutoDeleteBaselineDecision {
  kind: 'activity.auto-delete-baseline';
  /** A normalized ISO timestamp. */
  touchedAt: string;
}

export interface WorktreeMergedBaseRetargetDecision {
  kind: 'git.merged-base-retarget';
  /** `null` for a single-repository workspace's scalar base. */
  repoIds: Array<string | null>;
  /** Trimmed. */
  mergedBranchName: string;
  /** Trimmed. */
  mergedIntoBranchName: string;
  mergedWorktreeId?: string;
}

/** A decision over the whole worktree list of one workspace. */
export type WorktreeListDecision =
  | WorktreeAutoDeleteBaselineDecision
  | WorktreeMergedBaseRetargetDecision;

export interface WorktreeDecisionContext {
  /** The clock, read once per pass of the locked updater. */
  now: Date;
}

/**
 * `recorded` wrote the row; `unchanged` found the row already in that state
 * and wrote nothing; `not-found` found no such row (or a different
 * incarnation of it) and wrote nothing.
 */
export type WorktreeRecordStatus = 'recorded' | 'unchanged' | 'not-found';

export interface WorktreeRecordOutcome {
  status: WorktreeRecordStatus;
  /** The persisted row after the record, or null when it was not found. */
  worktree: WorktreeData | null;
}

export interface WorktreeActivityRecordOutcome {
  /**
   * The rows the record matched, as committed. A row whose watermark was
   * already as recent is included unchanged; an unknown worktree matches none.
   */
  worktrees: WorktreeData[];
  /** Whether a watermark advanced, so the list was written. */
  changed: boolean;
}

export interface WorktreeChatBadgesRecordOutcome {
  /** `unchanged`: the stored summary already matched, so nothing was written. */
  status: 'recorded' | 'unchanged' | 'not-found';
}

export interface WorktreeBaseRetargetOutcome {
  /** `unchanged` when no base tracked the merged branch; nothing was written. */
  status: 'recorded' | 'unchanged';
  /** Each base moved, in list order, for the renderer's event. */
  updates: DependentBaseBranchUpdate[];
}

export type WorktreeRowDecisionOutcome =
  | WorktreeActivityRecordOutcome
  | WorktreeChatBadgesRecordOutcome
  | WorktreeRecordOutcome;

export type WorktreeListDecisionOutcome =
  | WorktreeActivityRecordOutcome
  | WorktreeBaseRetargetOutcome;

/**
 * Applies record decisions to the worktree list, each under the list lock,
 * and returns the record operation's existing outcome. The in-process
 * implementation is `worktree-record-decision-port.ts`, with the list update
 * and removal, manifest and index members in
 * `workspace-record-decision-port.ts` and the ownership, Cowork and seed
 * members in `workspace-ownership-decision-port.ts`,
 * `cowork-record-decision-port.ts` and `workspace-index-seed-decision-port.ts`.
 */
export interface W5RecordDecisionPort {
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeActivityWatermarkDecision,
  ): Promise<WorktreeActivityRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeChatBadgesDecision,
  ): Promise<WorktreeChatBadgesRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeRecordRowDecision,
  ): Promise<WorktreeRecordOutcome>;
  applyWorktreeRowDecision(
    target: WorktreeRecordTarget,
    decision: WorktreeRowDecision,
  ): Promise<WorktreeRowDecisionOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeAutoDeleteBaselineDecision,
  ): Promise<WorktreeActivityRecordOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeMergedBaseRetargetDecision,
  ): Promise<WorktreeBaseRetargetOutcome>;
  applyWorktreeListDecision(
    workspaceId: string,
    decision: WorktreeListDecision,
  ): Promise<WorktreeListDecisionOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: CompositionJoinRecordDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<CompositionJoinRecordOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: CompositionSourceRecordDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<CompositionSourceRecordOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: PipelineResultsSeenDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<PipelineResultsSeenOutcome>;
  applyWorktreeListUpdate(
    workspaceId: string,
    decision: WorktreeListUpdateDecision,
    preconditions: WorktreeListPreconditions,
  ): Promise<WorktreeListUpdateOutcome>;
  applyWorktreeListRemoval(
    workspaceId: string,
    decision: WorktreeListRemovalDecision,
    preconditions: WorktreeListRemovalPreconditions,
  ): Promise<WorktreeListRemovalOutcome>;
  applyWorkspaceManifestDecision(
    workspaceId: string,
    decision: WorkspaceManifestDecision,
  ): Promise<void>;
  applyWorkspaceIndexDecision(decision: WorkspaceIndexDecision): Promise<void>;
  applyWorkspaceIndexRemoval(
    workspaceId: string,
    decision: WorkspaceIndexRemovalDecision,
  ): Promise<boolean>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    compare: WorkspaceOwnerCompare,
  ): Promise<WorkspaceOwnershipRecordStatus>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    decision: OrganizationOwnerRefreshDecision,
  ): Promise<OrganizationOwnerRefreshOutcome>;
  applyWorkspaceOwnerDecision(
    workspaceId: string,
    decision: WorkspaceOwnerCompare | OrganizationOwnerRefreshDecision,
  ): Promise<WorkspaceOwnershipRecordStatus | OrganizationOwnerRefreshOutcome>;
  applyPersonalCatalogIdDecision(
    workspaceId: string,
    decision: PersonalCatalogIdDecision,
    allowed: () => Promise<boolean>,
  ): Promise<string | undefined>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: OrganizationHookBindingsDecision,
  ): Promise<OrganizationHookBindingsOutcome>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: HookExecutionContextsRebindDecision,
  ): Promise<string[]>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: OrganizationPrivateMemoryDecision,
  ): Promise<OrganizationPrivateMemoryStatus>;
  applyWorkspaceOwnershipDecision(
    workspaceId: string,
    decision: WorkspaceOwnershipDecision,
  ): Promise<WorkspaceOwnershipDecisionOutcome>;
  applyAdoptedWorkspaceRelease(
    workspaceId: string,
    decision: AdoptedWorkspaceReleaseDecision,
  ): Promise<boolean>;
  applyWorkspaceIndexSeed(
    decision: WorkspaceIndexSeedDecision,
  ): Promise<{ seeded: boolean }>;
  applyCoworkProvisionDecision(
    decision: CoworkProvisionDecision,
  ): Promise<CoworkProvisionOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkMigrationDecision,
  ): Promise<CoworkMigrationOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkDefaultNameDecision,
  ): Promise<CoworkDefaultNameOutcome>;
  applyCoworkIndexDecision(
    decision: CoworkIndexDecision,
  ): Promise<CoworkIndexDecisionOutcome>;
  applyCoworkManifestDecision(
    workspaceId: string,
    decision: CoworkManifestDecision,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// W6d1 (CAN-4410): the workspace composition records (CAN-3823)
//
// The committed composition records and their rollbacks. A rollback is
// applied as an internal decision under the caller's ambient scope, as
// before: it opens no boundary step, so outside one its writer commits it.
// ---------------------------------------------------------------------------

/** A worktree incarnation: a different `createdAt` is another worktree. */
export type WorktreeIncarnation = Pick<WorktreeData, 'id' | 'createdAt'>;

/** What a read of a list, manifest or index proved. */
export type W5RecordReadAuthority = 'ok' | 'absent' | 'partial' | 'unreadable';

/**
 * X1: what a list update requires of the list read under its lock. A list
 * that fails them is refused with `WorktreeRegistryUnreadableError` before
 * the decision applies.
 */
export interface WorktreeListPreconditions {
  /** Refuse an unreadable or partial list. */
  requireAuthoritativeRead?: boolean;
  /** Refuse an absent list. */
  requireExistingList?: boolean;
  /**
   * Removed incarnations the update may add back despite their tombstones.
   * A committed write clears the tombstone of each one it persists, and no
   * other.
   */
  restoreWorktrees?: readonly WorktreeIncarnation[];
}

/** X2: what a list removal requires, and when it tombstones removed rows. */
export interface WorktreeListRemovalPreconditions {
  requireAuthoritativeRead?: boolean;
  requireExistingList?: boolean;
  /** Tombstone only after the write, so a failed removal stays retryable. */
  markRemovedAfterWrite?: boolean;
}

/** The source row fields a composition join records and its undo restores. */
export type CompositionSourceFields = Pick<
  WorktreeData,
  'trackedRepoBaseBranches' | 'compatibilitySymlinks' | 'adhocTransitionSource'
>;

/** Records the joined destination row once; a retry keeps it. */
export interface CompositionJoinRecordDecision {
  kind: 'composition.join.record';
  worktreeId: string;
  sourceWorktree: WorktreeData;
  consumedWorktrees?: readonly WorktreeData[];
  repoIdRewrites: Record<string, string>;
  compatibilitySymlinks: WorktreeCompatibilitySymlink[];
  transition: AdhocMultiRepoTransitionSource;
  joinedTrackedBranches?: WorktreeData['trackedRepoBaseBranches'];
}

/** Undoes the fields a join wrote into an existing row, where still current. */
export interface CompositionJoinUndoDecision {
  kind: 'composition.join.undo';
  worktree: WorktreeIncarnation;
  before: WorktreeData;
  written: WorktreeData;
}

/** Marks the source row's absorption of the joined worktree. */
export interface CompositionSourceRecordDecision {
  kind: 'composition.source.record';
  worktree: WorktreeIncarnation;
  trackedBranches?: WorktreeData['trackedRepoBaseBranches'];
  compatibilitySymlinks: WorktreeCompatibilitySymlink[];
  transition: AdhocMultiRepoTransitionSource;
}

/** Undoes the source fields a join wrote, where still current. */
export interface CompositionSourceUndoDecision {
  kind: 'composition.source.undo';
  worktree: WorktreeIncarnation;
  before: CompositionSourceFields;
  written: CompositionSourceFields;
}

/**
 * Adds back only the removed rows that are missing, each before the next row
 * of `order` still present; current rows, fields and order are kept.
 */
export interface CompositionRowsRestoreDecision {
  kind: 'composition.rows.restore';
  rows: readonly WorktreeData[];
  /** Identity-only anchors read under the removal lock. */
  order?: readonly string[];
}

/** Seeds a temporary project's empty list, and its manifest under that lock. */
export interface TemporaryCompositionCreateDecision {
  kind: 'composition.temporary.create';
  /** Applied inside the list update, once the list read proved it absent. */
  manifest: TemporaryCompositionManifestDecision;
}

export type WorktreeListUpdateDecision =
  | CompositionJoinRecordDecision
  | CompositionJoinUndoDecision
  | CompositionSourceRecordDecision
  | CompositionSourceUndoDecision
  | CompositionRowsRestoreDecision
  | TemporaryCompositionCreateDecision;

/** Removes only the named incarnation; another one at its id is refused. */
export interface CompositionRowRemoveDecision {
  kind: 'composition.row.remove';
  worktree: WorktreeIncarnation;
}

export type WorktreeListRemovalDecision = CompositionRowRemoveDecision;

/** Removes the repositories this composition added, by id and path. */
export interface CompositionRepositoriesUndoDecision {
  kind: 'composition.repositories.undo';
  repositories: readonly WorkspaceRepoData[];
}

/** Creates an absent temporary project manifest. */
export interface TemporaryCompositionManifestDecision {
  kind: 'composition.temporary.manifest';
  repos: WorkspaceRepoData[];
  temporarySourceWorkspaceIds?: string[];
  temporaryRepoIdentityKeys?: string[];
}

/** Promotes a temporary project, renaming its index entry under the lock. */
export interface CompositionPromotionDecision {
  kind: 'composition.promote';
  sourceRepoPath: string;
  /** Applied inside the manifest update, between its checks and its change. */
  index: CompositionPromotionIndexDecision;
}

export type WorkspaceManifestDecision =
  | CompositionRepositoriesUndoDecision
  | TemporaryCompositionManifestDecision
  | CompositionPromotionDecision;

/** Appends a temporary project's entry; an index that leaves entries out is refused. */
export interface TemporaryCompositionIndexDecision {
  kind: 'composition.temporary.index';
  entry: Omit<WorkspaceIndexEntry, 'order'>;
}

/** Renames a multi-repo project's entry. */
export interface CompositionPromotionIndexDecision {
  kind: 'composition.promote.index';
  workspaceId: string;
  /** Trimmed. */
  name: string;
}

export type WorkspaceIndexDecision =
  | TemporaryCompositionIndexDecision
  | CompositionPromotionIndexDecision;

/**
 * A failed composition's targeted index removal (F8). It removes only this
 * project's entry; the remaining entries are renumbered and the post-commit
 * registry, remembered sidebar ids and Portal notification follow, as for
 * every index entry removal.
 */
export interface CompositionDestinationCleanupDecision {
  kind: 'composition.destination.cleanup';
}

export type WorkspaceIndexRemovalDecision =
  CompositionDestinationCleanupDecision;

export interface WorktreeListUpdateOutcome {
  /** The list as committed, or as read when nothing was written. */
  worktrees: WorktreeData[];
}

/** What the last pass that wrote the joined row read and wrote. */
export interface CompositionJoinRecorded {
  /** Absent when the pass appended a new row. */
  before?: WorktreeData;
  written: WorktreeData;
}

export interface CompositionJoinRecordOutcome extends WorktreeListUpdateOutcome {
  /** Absent when no pass wrote: a retry found the row recorded. */
  recorded?: CompositionJoinRecorded;
}

export interface CompositionSourceRecorded {
  before: CompositionSourceFields;
  written: CompositionSourceFields;
}

export interface CompositionSourceRecordOutcome extends WorktreeListUpdateOutcome {
  recorded?: CompositionSourceRecorded;
}

export interface WorktreeListRemovalOutcome {
  /** Exactly the rows removed under the lock. */
  rows: WorktreeData[];
  /** The ids of every row the removal read under the lock, in list order. */
  order: string[];
}

// ---------------------------------------------------------------------------
// W5c2 (CAN-4807): the ownership records (CAN-3819), the organization private
// memory record (CAN-3817), the index seed, the default Cowork provision,
// the legacy Cowork migration and default-name migration (CAN-3818), and the
// sidebar seen record (CAN-3821)
//
// D9 internal decisions: no key, client revision or receipt. None runs in a
// boundary step, so each write commits on its own, as before. Where the
// writer already holds the guard (the ownership writer, the personal catalog
// enrollment, the hook binding and the default-name rename) the port applies
// the decision through that writer unchanged. The materialization's ownership
// compare and the catalog sync's `allowed` are host steps the writer runs on
// its read in the manifest queue; they are port arguments, not decision data.
// The seed decision carries a host path.
// ---------------------------------------------------------------------------

/** What a manifest read in its queue showed; `absent` passes the default config. */
export interface W5ManifestRead {
  authority: 'ok' | 'absent';
  ownerMalformed: boolean;
  memoryMalformed: boolean;
}

/** `updateWorkspaceOwnership`'s outcome. */
export type WorkspaceOwnershipRecordStatus =
  | 'written'
  | 'declined'
  | 'absent'
  | 'unreadable';

/** The authoritative ownership read in the manifest queue. */
export interface WorkspaceOwnershipSnapshot {
  authority: 'ok';
  type: WorkspaceConfigFile['type'];
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}

/** Replaces the owner binding and ownership transfer; every other field is kept. */
export interface WorkspaceOwnerDecision {
  kind: 'ownership.owner';
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
}

/** A host compare on the queued read: the replacement, or `null` to decline. */
export type WorkspaceOwnerCompare = (
  current: WorkspaceOwnershipSnapshot,
) => WorkspaceOwnerDecision | null;

export type OrganizationOwnerBinding = Extract<
  WorkspaceOwnerBinding,
  { type: 'organization' }
>;

/** Moves the fence forward on a re-claim of the same instance. */
export interface OrganizationOwnerRefreshDecision {
  kind: 'ownership.organization.refresh';
  owner: OrganizationOwnerBinding;
}

export interface OrganizationOwnerRefreshOutcome {
  status: WorkspaceOwnershipRecordStatus;
  /** The binding the workspace holds after the decision; absent when it is bound to anything else. */
  held?: OrganizationOwnerBinding;
}

/** Enrolls a Personal workspace, allocating its id when it has none. */
export interface PersonalCatalogIdDecision {
  kind: 'ownership.personal-catalog-id';
}

/** Binds inherited organization hooks in the local hooks. */
export interface OrganizationHookBindingsDecision {
  kind: 'ownership.hook-bindings';
  /** The workspace root when omitted. */
  repoId?: string;
  sourceHooks: WorkspaceConfigFile['hooks'];
  localHooks: WorkspaceConfigFile['hooks'];
  owner: WorkspaceOwnerBinding | undefined;
}

export interface OrganizationHookBindingsOutcome {
  hooks: WorkspaceConfigFile['hooks'];
  owner: WorkspaceOwnerBinding | undefined;
}

/** Rebinds machine-local hook actions after an owner change; writes only when one moved. */
export interface HookExecutionContextsRebindDecision {
  kind: 'ownership.hook-contexts.rebind';
  previousContext: string;
  nextContext: string;
}

/**
 * Checks the binding on the manifest read in its queue, writing no manifest,
 * then applies its targeted index removal there.
 */
export interface AdoptedWorkspaceReleaseDecision {
  kind: 'ownership.adoption.release';
  /** The claim instance the adoption bound the workspace to. */
  instanceId: string;
  index: AdoptedWorkspaceIndexReleaseDecision;
}

/** Removes only this workspace's index entry; the others keep their order. */
export interface AdoptedWorkspaceIndexReleaseDecision {
  kind: 'ownership.adoption.release.index';
  workspaceId: string;
}

/** The release check on the queued manifest read. */
export type AdoptedWorkspaceReleaseCheck =
  | 'absent'
  | 'owner-unreadable'
  | 'bound-elsewhere'
  | 'bound';

/** Records an organization project's inherited policy and its marker. */
export interface OrganizationPrivateMemoryDecision {
  kind: 'ownership.private-memory';
  organizationId: string;
  projectId: string;
  privateMemory: boolean;
}

/**
 * `refused`: the manifest is missing, its owner or policy is unreadable, or it
 * is bound elsewhere; nothing was written.
 */
export type OrganizationPrivateMemoryStatus =
  | 'recorded'
  | 'unchanged'
  | 'refused';

/** The ownership decisions that read and write only the manifest. */
export type WorkspaceOwnershipDecision =
  | OrganizationHookBindingsDecision
  | HookExecutionContextsRebindDecision
  | OrganizationPrivateMemoryDecision;

export type WorkspaceOwnershipDecisionOutcome =
  | OrganizationHookBindingsOutcome
  | string[]
  | OrganizationPrivateMemoryStatus;

/** Publishes an empty primary index only if absent. */
export interface WorkspaceIndexSeedDecision {
  kind: 'index.seed';
  /** A host path: the explicit primary data directory. */
  primaryDataDir: string;
}

/**
 * Provisions the default Cowork workspace from the index and manifest read
 * under their queues: its manifest is decided inside the index update, and
 * its home is scaffolded there before the index is published.
 */
export interface CoworkProvisionDecision {
  kind: 'cowork.provision';
  workspaceId: string;
  owner?: WorkspaceOwnerBinding;
  publishToIndex: boolean;
  /** The default name and creation time. */
  name: string;
  createdAt: string;
}

/** Each pass of the provisioning manifest update. */
export interface CoworkProvisionManifestPass {
  item: CoworkSidebarItem;
  changed: boolean;
  scaffold: boolean;
  deferManifest?: boolean;
}

export interface CoworkProvisionOutcome {
  item: CoworkSidebarItem;
  notify: boolean;
  /** An unbound default's manifest, created after the index entry. */
  deferredManifest?: CoworkSidebarItem;
}

/** Allocates or reuses a migrated legacy Cowork identity under the index queue. */
export interface CoworkMigrationDecision {
  kind: 'cowork.migration';
  candidateId: string;
  name: string;
  color?: string;
  cowork?: CoworkWorkspaceSettings;
}

export interface CoworkMigrationOutcome {
  id: string;
  created: boolean;
}

/** Renames the entry only while it still has one of `onlyWhenNamed`. */
export interface CoworkDefaultNameDecision {
  kind: 'cowork.default-name';
  workspaceId: string;
  name: string;
  onlyWhenNamed: readonly string[];
}

export interface CoworkDefaultNameOutcome {
  authority: W5RecordReadAuthority;
  renamed: boolean;
}

/** The Cowork decisions that write only the index. */
export type CoworkIndexDecision =
  | CoworkMigrationDecision
  | CoworkDefaultNameDecision;

export type CoworkIndexDecisionOutcome =
  | CoworkMigrationOutcome
  | CoworkDefaultNameOutcome;

/** Creates an unbound default's absent manifest after its index entry. */
export interface CoworkProvisionManifestDecision {
  kind: 'cowork.provision.manifest';
  item: CoworkSidebarItem;
}

/** Writes a migrated workspace's Cowork type and settings, keeping unknown ones. */
export interface CoworkMigrationManifestDecision {
  kind: 'cowork.migration.manifest';
  cowork?: CoworkWorkspaceSettings;
}

export type CoworkManifestDecision =
  | CoworkProvisionManifestDecision
  | CoworkMigrationManifestDecision;

/** Applies a seen delta to the named incarnation only. */
export interface PipelineResultsSeenDecision {
  kind: 'pipelineResults.markSeen';
  worktree: WorktreeIncarnation;
  seen: readonly string[];
  unseen: readonly string[];
}

export interface PipelineResultsSeenOutcome extends WorktreeListUpdateOutcome {
  /** Executions the last matching pass newly marked seen. */
  newlySeen: string[];
}
