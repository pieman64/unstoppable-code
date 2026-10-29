import type {
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  DependentBaseBranchUpdate,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
  WorktreeChatBadgeChatRef,
  WorktreeChatBadgesSummary,
  WorktreeCompatibilitySymlink,
  WorktreeData,
  WorktreeHealthIssue,
  WorktreeHealthRepoIssue,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types';
import type {
  AdoptedWorkspaceIndexReleaseDecision,
  AdoptedWorkspaceReleaseCheck,
  AdoptedWorkspaceReleaseDecision,
  CoworkMigrationDecision,
  CoworkMigrationManifestDecision,
  CoworkProvisionDecision,
  CoworkProvisionManifestDecision,
  CoworkProvisionManifestPass,
  CoworkProvisionOutcome,
  HookExecutionContextsRebindDecision,
  OrganizationOwnerBinding,
  OrganizationOwnerRefreshDecision,
  OrganizationPrivateMemoryDecision,
  OrganizationPrivateMemoryStatus,
  PipelineResultsSeenDecision,
  W5ManifestRead,
  WorkspaceOwnerDecision,
  WorkspaceOwnershipSnapshot,
  CompositionJoinRecordDecision,
  CompositionJoinRecorded,
  CompositionJoinUndoDecision,
  CompositionPromotionDecision,
  CompositionRepositoriesUndoDecision,
  CompositionRowRemoveDecision,
  CompositionRowsRestoreDecision,
  CompositionSourceFields,
  CompositionSourceRecordDecision,
  CompositionSourceRecorded,
  CompositionSourceUndoDecision,
  TemporaryCompositionManifestDecision,
  W5RecordReadAuthority,
  WorkspaceIndexDecision,
  WorktreeChatBadgesDecision,
  WorktreeDecisionContext,
  WorktreeDiscoveryDecision,
  WorktreeGitRowDecision,
  WorktreeHealthDecision,
  WorktreeIncarnation,
  WorktreeListDecision,
  WorktreeMergedBaseRetargetDecision,
  WorktreeRecoveryDecision,
  WorktreeRowDecision,
} from './worktree-record-decisions';

// The pure apply of each record decision (W6-0): the logic of the record
// functions' locked updaters, with no I/O and no clock read of its own. Keep
// imports to shared types and sibling pure modules, so a host other than the
// desktop main process can load it.

/**
 * The row after `decision`: the row itself when the decision writes nothing,
 * or `null` when the stored row is not the incarnation the decision names.
 */
export function applyWorktreeRowDecisionTo(
  current: WorktreeData,
  decision: WorktreeRowDecision,
  context: WorktreeDecisionContext,
): WorktreeData | null {
  switch (decision.kind) {
    case 'activity.watermark':
      return advanceWatermark(current, decision.touchedAt);
    case 'chatBadges':
      return applyChatBadges(current, decision);
    case 'git.branch':
    case 'git.pr-status':
    case 'git.split-child-grouping':
    case 'git.split-original-retarget':
      return applyGitRow(current, decision);
    case 'health':
      return applyHealth(current, decision);
    case 'discovery.environment':
    case 'discovery.branch-prompt':
      return applyDiscovery(current, decision);
    case 'recovery.promote-pending':
    case 'recovery.complete-source-root-repair':
    case 'recovery.expose-create-reservation':
    case 'recovery.expose-split-reservation':
      return current.createdAt === decision.createdAt
        ? applyRecovery(current, decision, context)
        : null;
  }
}

/** The list after `decision`, or the same list when it writes nothing. */
export function applyWorktreeListDecisionTo(
  current: WorktreeData[],
  decision: WorktreeListDecision,
): WorktreeData[] {
  switch (decision.kind) {
    case 'activity.auto-delete-baseline': {
      const next = current.map((worktree) =>
        advanceWatermark(worktree, decision.touchedAt),
      );
      return next.some((worktree, index) => worktree !== current[index])
        ? next
        : current;
    }
    case 'git.merged-base-retarget':
      return planMergedBaseRetarget(current, decision).worktrees;
  }
}

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------

/** The row with its watermark advanced to `touchedAt`, or the same row. */
function advanceWatermark(
  worktree: WorktreeData,
  touchedAt: string,
): WorktreeData {
  // An absent or unparsable watermark is older than any touch.
  return Date.parse(worktree.lastTouchedAt ?? '') >= Date.parse(touchedAt)
    ? worktree
    : { ...worktree, lastTouchedAt: touchedAt };
}

// ---------------------------------------------------------------------------
// chat badges
// ---------------------------------------------------------------------------

/** Summaries older than this lack `chatName` and are backfilled. */
export const CHAT_BADGES_SUMMARY_VERSION = 2;

function badgeRefsEqual(
  left: WorktreeChatBadgeChatRef[],
  right: WorktreeChatBadgeChatRef[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((ref, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      ref.chatId === other.chatId &&
      ref.title === other.title &&
      ref.providerType === other.providerType &&
      ref.preview === other.preview
    );
  });
}

/** Equality ignoring `updatedAt`, so unchanged badges skip the disk write. */
export function chatBadgesSummariesEquivalent(
  left: WorktreeChatBadgesSummary | undefined,
  right: WorktreeChatBadgesSummary,
): boolean {
  if (!left) {
    // An absent summary is equivalent to an empty one — avoids writing a
    // no-badge summary into every legacy worktree entry on the first save.
    return (
      right.unreadChats.length === 0 &&
      right.approvalChats.length === 0 &&
      !right.needsHydration &&
      right.chatName === undefined
    );
  }
  return (
    left.version === right.version &&
    left.chatName === right.chatName &&
    left.needsHydration === right.needsHydration &&
    badgeRefsEqual(left.unreadChats, right.unreadChats) &&
    badgeRefsEqual(left.approvalChats, right.approvalChats)
  );
}

function applyChatBadges(
  worktree: WorktreeData,
  decision: WorktreeChatBadgesDecision,
): WorktreeData {
  const current = worktree.chatBadges;
  const { summary } = decision;
  if (decision.source === 'chat_commit') {
    // An empty summary over badges is a deliberate clear and is written.
    return chatBadgesSummariesEquivalent(current, summary)
      ? worktree
      : { ...worktree, chatBadges: summary };
  }
  if (current === undefined) return { ...worktree, chatBadges: summary };
  if (current.version >= CHAT_BADGES_SUMMARY_VERSION) return worktree;
  // A concurrent live commit may have written newer badges than the
  // backfill's read saw, so keep them and add only the chat name.
  return {
    ...worktree,
    chatBadges: {
      ...current,
      version: CHAT_BADGES_SUMMARY_VERSION,
      ...(summary.chatName ? { chatName: summary.chatName } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// git rows
// ---------------------------------------------------------------------------

function applyGitRow(
  current: WorktreeData,
  decision: WorktreeGitRowDecision,
): WorktreeData {
  switch (decision.kind) {
    case 'git.branch':
      return applyWorktreeBranchChange(
        current,
        decision.branchName,
        decision.updatesSidebarBranch,
      );
    case 'git.pr-status':
      return applyPrStatus(current, decision.status);
    case 'git.split-child-grouping':
      return current.branchGroupingOverride === 'group'
        ? current
        : { ...current, branchGroupingOverride: 'group' };
    case 'git.split-original-retarget': {
      const { branchName, trackedBaseBranch } = decision;
      return current.branchName === branchName &&
        current.trackedBaseBranch === trackedBaseBranch
        ? current
        : { ...current, branchName, trackedBaseBranch };
    }
  }
}

/**
 * A worktree checkout moved to `branchName`: the sidebar branch follows a
 * root or single-repository change, and the stored PR status, which belonged
 * to the old branch, is cleared. Returns the row itself when it already holds
 * that state. Shared with `core.worktree.branch.rename`.
 */
export function applyWorktreeBranchChange(
  current: WorktreeData,
  branchName: string,
  updatesSidebarBranch: boolean,
): WorktreeData {
  const nextBranchName = updatesSidebarBranch ? branchName : current.branchName;
  if (
    current.branchName === nextBranchName &&
    current.lastKnownPrStatus === null &&
    current.status === undefined
  ) {
    return current;
  }
  const next: WorktreeData = {
    ...current,
    branchName: nextBranchName,
    lastKnownPrStatus: null,
  };
  delete next.status;
  return next;
}

/**
 * Whether two PR statuses report the same repositories. An absent stored
 * status never matches, so the first poll is always persisted.
 */
export function areEquivalentPrStatuses(
  stored: WorktreePrStatus | null | undefined,
  status: WorktreePrStatus | null,
): boolean {
  if (stored === undefined) return false;
  return (
    JSON.stringify(stored?.repos ?? null) ===
    JSON.stringify(status?.repos ?? null)
  );
}

function applyPrStatus(
  current: WorktreeData,
  status: WorktreePrStatus | null,
): WorktreeData {
  const reposWithPrs =
    status?.repos.filter((repo) => repo.status !== null) ?? [];
  const allKnownPrsMerged =
    reposWithPrs.length > 0 &&
    reposWithPrs.every((repo) => repo.status?.state === 'merged');
  const hasOpenPr =
    status?.repos.some(
      (repo) => repo.status?.state === 'open' || repo.status?.state === 'draft',
    ) ?? false;
  const nextStatus = allKnownPrsMerged
    ? 'done'
    : hasOpenPr
      ? undefined
      : current.status;
  if (
    areEquivalentPrStatuses(current.lastKnownPrStatus, status) &&
    current.status === nextStatus
  ) {
    return current;
  }
  const next: WorktreeData = { ...current, lastKnownPrStatus: status };
  if (nextStatus) {
    next.status = nextStatus;
  } else {
    delete next.status;
  }
  return next;
}

// ---------------------------------------------------------------------------
// merged-base-retarget
// ---------------------------------------------------------------------------

/** A moved base; the caller adds the workspace as `projectId`. */
export type MergedBaseRetargetUpdate = Omit<
  DependentBaseBranchUpdate,
  'projectId'
>;

function retargetBase(
  worktree: WorktreeData,
  repoId: string | null,
  mergedBranchName: string,
  mergedIntoBranchName: string,
): WorktreeData {
  if (repoId === null) {
    return worktree.trackedBaseBranch === mergedBranchName
      ? { ...worktree, trackedBaseBranch: mergedIntoBranchName }
      : worktree;
  }
  const bases = worktree.trackedRepoBaseBranches;
  if (bases?.[repoId] !== mergedBranchName) return worktree;
  return {
    ...worktree,
    trackedRepoBaseBranches: { ...bases, [repoId]: mergedIntoBranchName },
  };
}

/**
 * The list with every base that tracked the merged branch moved to the branch
 * it merged into, and each move in list order. The same list when none moved.
 */
export function planMergedBaseRetarget(
  worktrees: WorktreeData[],
  decision: WorktreeMergedBaseRetargetDecision,
): { worktrees: WorktreeData[]; updates: MergedBaseRetargetUpdate[] } {
  const { repoIds, mergedBranchName, mergedIntoBranchName, mergedWorktreeId } =
    decision;
  const updates: MergedBaseRetargetUpdate[] = [];
  const next = worktrees.map((worktree) => {
    if (worktree.id === mergedWorktreeId) return worktree;
    let nextWorktree = worktree;
    for (const repoId of repoIds) {
      const previousBaseBranch =
        repoId === null
          ? nextWorktree.trackedBaseBranch
          : nextWorktree.trackedRepoBaseBranches?.[repoId];
      const retargeted = retargetBase(
        nextWorktree,
        repoId,
        mergedBranchName,
        mergedIntoBranchName,
      );
      if (retargeted === nextWorktree) continue;
      updates.push({
        worktreeId: worktree.id,
        ...(repoId !== null ? { repoId } : {}),
        previousBaseBranch: previousBaseBranch ?? mergedBranchName,
        nextBaseBranch: mergedIntoBranchName,
        ...(mergedWorktreeId
          ? { branchGroupingParentWorktreeId: mergedWorktreeId }
          : {}),
      });
      nextWorktree = mergedWorktreeId
        ? {
            ...retargeted,
            branchGroupingParentWorktreeId: mergedWorktreeId,
          }
        : retargeted;
    }
    return nextWorktree;
  });
  return { worktrees: updates.length > 0 ? next : worktrees, updates };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

function compareRepoIssues(
  left: WorktreeHealthRepoIssue,
  right: WorktreeHealthRepoIssue,
): number {
  const key = (issue: WorktreeHealthRepoIssue): string =>
    [
      issue.repoId,
      issue.repoName,
      issue.repoPath,
      issue.code,
      issue.message,
      issue.gitError ?? '',
    ].join('\u0000');
  return key(left).localeCompare(key(right));
}

function repoIssuesEqual(
  left: WorktreeHealthRepoIssue[] | undefined,
  right: WorktreeHealthRepoIssue[] | undefined,
): boolean {
  const leftIssues = [...(left ?? [])].sort(compareRepoIssues);
  const rightIssues = [...(right ?? [])].sort(compareRepoIssues);
  return (
    leftIssues.length === rightIssues.length &&
    leftIssues.every((issue, index) => {
      const other = rightIssues[index];
      return other !== undefined && compareRepoIssues(issue, other) === 0;
    })
  );
}

/** Whether two issues report the same problem, ignoring `checkedAt`. */
function sameHealthIssue(
  stored: WorktreeHealthIssue | undefined,
  issue: WorktreeHealthIssue,
): boolean {
  return (
    stored?.status === 'broken' &&
    stored.code === issue.code &&
    stored.message === issue.message &&
    stored.worktreePath === issue.worktreePath &&
    (stored.gitError ?? null) === (issue.gitError ?? null) &&
    repoIssuesEqual(stored.repoIssues, issue.repoIssues)
  );
}

function applyHealth(
  current: WorktreeData,
  decision: WorktreeHealthDecision,
): WorktreeData {
  const { issue } = decision;
  if (issue === null) {
    if (!current.healthIssue && current.splitRecoveryRequired !== true) {
      return current;
    }
    const next: WorktreeData = { ...current };
    delete next.healthIssue;
    delete next.splitRecoveryRequired;
    return next;
  }
  if (
    decision.source === 'diff-stats' &&
    sameHealthIssue(current.healthIssue, issue)
  ) {
    return current;
  }
  return { ...current, healthIssue: issue };
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

function applyDiscovery(
  current: WorktreeData,
  decision: WorktreeDiscoveryDecision,
): WorktreeData {
  if (decision.kind === 'discovery.environment') {
    return { ...current, discovery: decision.discovery };
  }
  const { sent } = decision;
  return current.branchPromptSent === sent
    ? current
    : { ...current, branchPromptSent: sent };
}

// ---------------------------------------------------------------------------
// recovery
// ---------------------------------------------------------------------------

const CREATE_RESERVATION_MESSAGE =
  'Worktree creation was interrupted. Review the retained checkout before continuing.';

const SPLIT_RESERVATION_MESSAGE =
  'A split was interrupted after destination data was reserved. This worktree was retained for explicit recovery.';

/** Applied only to the incarnation the decision names. */
function applyRecovery(
  current: WorktreeData,
  decision: WorktreeRecoveryDecision,
  { now }: WorktreeDecisionContext,
): WorktreeData | null {
  switch (decision.kind) {
    case 'recovery.complete-source-root-repair':
      // A newer reservation at this id must not be completed by this repair.
      if (current.creation?.operationId !== decision.operationId) return null;
      if (
        current.creation.state !== 'recovery-required' ||
        current.creation.phase !== 'source-root-repair' ||
        current.setupPhase !== 'git-pending'
      )
        return current;
      return {
        ...current,
        setupPhase: 'git-ready',
        creation: {
          ...current.creation,
          state: 'complete',
          phase: 'git-ready',
        },
      };
    case 'recovery.expose-create-reservation':
      if (
        !current.creation ||
        current.creation.operationId !== decision.operationId ||
        current.creation.state === 'complete' ||
        current.creation.state === 'recovery-required'
      )
        return current;
      return {
        ...current,
        creation: { ...current.creation, state: 'recovery-required' },
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: CREATE_RESERVATION_MESSAGE,
          checkedAt: now.toISOString(),
          worktreePath: decision.worktreePath,
        },
      };
    case 'recovery.promote-pending':
      return current.setupPhase === 'git-pending' && !current.creation
        ? {
            ...current,
            branchName: decision.branchName,
            setupPhase: 'git-ready',
          }
        : current;
    case 'recovery.expose-split-reservation': {
      const recovered: WorktreeData = { ...current };
      delete recovered.hidden;
      delete recovered.setupPhase;
      return {
        ...recovered,
        splitRecoveryRequired: true,
        healthIssue: {
          status: 'broken',
          code: 'git-error',
          message: SPLIT_RESERVATION_MESSAGE,
          checkedAt: now.toISOString(),
          worktreePath: decision.worktreePath,
          gitError: 'Split transaction did not reach background completion.',
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// composition records (W6d1)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * `util.isDeepStrictEqual` for the plain data of rows and decisions: the same
 * prototype, own keys (one holding `undefined` counts) and `Object.is`
 * leaves. Dates, maps, sets and boxed primitives never occur in that data and
 * are not compared by value.
 */
export function isDeepStrictEqualData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isRecord(left) || !isRecord(right)) return false;
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right))
    return false;
  if (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length !== right.length
  )
    return false;
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        isDeepStrictEqualData(left[key], right[key]),
    )
  );
}

export type CompositionRecordRefusal =
  | 'invalid-request'
  | 'identity-changed'
  | 'not-found'
  | 'worktrees-unavailable'
  | 'configuration-unavailable'
  | 'index-unavailable'
  | 'not-temporary';

export class CompositionRecordRefusedError extends Error {
  constructor(
    readonly reason: CompositionRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionRecordRefusedError';
  }
}

function refuse(
  reason: CompositionRecordRefusal,
  message: string,
): CompositionRecordRefusedError {
  return new CompositionRecordRefusedError(reason, message);
}

export function isSameIncarnation(
  row: WorktreeIncarnation,
  identity: WorktreeIncarnation,
): boolean {
  return row.id === identity.id && row.createdAt === identity.createdAt;
}

export function compositionIdentityChanged(
  id: string,
): CompositionRecordRefusedError {
  return refuse(
    'identity-changed',
    `Worktree ${id} no longer matches its composition identity`,
  );
}

export function mapTrackedRepoBaseBranches(
  source: WorktreeData,
  repoIdRewrites: Record<string, string>,
): Record<string, string> | undefined {
  const fallbackBranch =
    typeof source.trackedBaseBranch === 'string' &&
    source.trackedBaseBranch.trim()
      ? source.trackedBaseBranch.trim()
      : undefined;
  const mapped: Record<string, string> = {};
  for (const [sourceRepoId, destinationRepoId] of Object.entries(
    repoIdRewrites,
  )) {
    const mappedBranch =
      source.trackedRepoBaseBranches?.[sourceRepoId]?.trim() || undefined;
    const branch = mappedBranch ?? fallbackBranch;
    if (branch) {
      mapped[destinationRepoId] = branch;
    }
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

export function buildDestinationWorktree(params: {
  id: string;
  sourceWorktree: WorktreeData;
  consumedWorktrees?: readonly WorktreeData[];
  repoIdRewrites: Record<string, string>;
  compatibilitySymlinks: WorktreeCompatibilitySymlink[];
  existingDestinationWorktree?: WorktreeData;
}): WorktreeData {
  const metadataWorktrees = [
    params.sourceWorktree,
    ...(params.consumedWorktrees ?? []),
    ...(params.existingDestinationWorktree
      ? [params.existingDestinationWorktree]
      : []),
  ];
  const seenPipelineExecutionIds = Array.from(
    new Set(
      [
        ...(params.existingDestinationWorktree
          ? [params.existingDestinationWorktree]
          : []),
        params.sourceWorktree,
        ...(params.consumedWorktrees ?? []),
      ].flatMap((worktree) => worktree.seenPipelineExecutionIds ?? []),
    ),
  );
  const lastTouchedAt = metadataWorktrees.reduce<string | undefined>(
    (latest, worktree) => {
      const candidate = worktree.lastTouchedAt;
      if (!candidate || !Number.isFinite(Date.parse(candidate))) return latest;
      return !latest || Date.parse(candidate) >= Date.parse(latest)
        ? candidate
        : latest;
    },
    undefined,
  );
  return {
    id: params.id,
    branchName: params.sourceWorktree.branchName,
    createdAt: params.sourceWorktree.createdAt,
    // The combined destination has new Git ownership, not the source's
    // files-only restore provenance.
    restoredFromFilesOnlyArchiveId: undefined,
    lastTouchedAt,
    discovery: params.sourceWorktree.discovery,
    branchPromptSent: params.sourceWorktree.branchPromptSent,
    status: params.sourceWorktree.status,
    label: params.sourceWorktree.label,
    pausedHookKeys: params.sourceWorktree.pausedHookKeys,
    seenPipelineExecutionIds:
      seenPipelineExecutionIds.length > 0
        ? seenPipelineExecutionIds
        : undefined,
    healthIssue: params.sourceWorktree.healthIssue,
    lastKnownPrStatus: params.sourceWorktree.lastKnownPrStatus,
    trackedBaseBranch: params.sourceWorktree.trackedBaseBranch,
    trackedRepoBaseBranches: mapTrackedRepoBaseBranches(
      params.sourceWorktree,
      params.repoIdRewrites,
    ),
    branchGroupingOverride: params.sourceWorktree.branchGroupingOverride,
    branchGroupingParentWorktreeId:
      params.sourceWorktree.branchGroupingParentWorktreeId,
    setupPhase: 'git-ready',
    splitRecoveryRequired: undefined,
    compatibilitySymlinks: params.compatibilitySymlinks,
    // Chats migrate with the worktree; carry the derived badge summary too
    // (re-derived on the next chat save either way).
    chatBadges: params.sourceWorktree.chatBadges,
    // Adhoc combine materializes a new effective repository set, so a
    // restricted source scope must not constrain the destination.
    includedRepoIds: undefined,
  };
}

/** One pass of a list update that records what it wrote. */
export interface CompositionListPass<R> {
  worktrees: WorktreeData[];
  /** Absent when the pass wrote nothing. */
  recorded?: R;
}

export function applyCompositionJoinRecordTo(
  rows: WorktreeData[],
  decision: CompositionJoinRecordDecision,
): CompositionListPass<CompositionJoinRecorded> {
  const identity = {
    id: decision.worktreeId,
    createdAt: decision.sourceWorktree.createdAt,
  };
  const existing = rows.find((row) => row.id === identity.id);
  if (existing) {
    if (!isSameIncarnation(existing, identity))
      throw compositionIdentityChanged(identity.id);
    const transition = existing.adhocTransitionSource;
    if (transition) {
      if (
        transition.sourceWorkspaceId !==
          decision.transition.sourceWorkspaceId ||
        transition.sourceWorktreeId !== decision.transition.sourceWorktreeId ||
        transition.joinedWorktreeMigration?.workspaceId !==
          decision.transition.joinedWorktreeMigration?.workspaceId ||
        transition.joinedWorktreeMigration?.worktreeId !==
          decision.transition.joinedWorktreeMigration?.worktreeId
      )
        throw compositionIdentityChanged(identity.id);
      return { worktrees: rows };
    }
  }
  const row = buildDestinationWorktree({
    id: decision.worktreeId,
    sourceWorktree: decision.sourceWorktree,
    consumedWorktrees: decision.consumedWorktrees,
    repoIdRewrites: decision.repoIdRewrites,
    compatibilitySymlinks: decision.compatibilitySymlinks,
    existingDestinationWorktree: existing,
  });
  const next: WorktreeData = existing
    ? {
        ...existing,
        setupPhase: row.setupPhase,
        splitRecoveryRequired: row.splitRecoveryRequired,
        includedRepoIds: row.includedRepoIds,
        lastTouchedAt: row.lastTouchedAt,
        seenPipelineExecutionIds: row.seenPipelineExecutionIds,
        trackedRepoBaseBranches: {
          ...existing.trackedRepoBaseBranches,
          ...row.trackedRepoBaseBranches,
        },
        compatibilitySymlinks: [
          ...(existing.compatibilitySymlinks ?? []),
          ...decision.compatibilitySymlinks,
        ],
      }
    : row;
  if (decision.joinedTrackedBranches)
    next.trackedRepoBaseBranches = {
      ...next.trackedRepoBaseBranches,
      ...decision.joinedTrackedBranches,
    };
  next.adhocTransitionSource = decision.transition;
  return {
    worktrees: existing
      ? rows.map((current) => (current === existing ? next : current))
      : [...rows, next],
    recorded: { before: existing, written: next },
  };
}

const DESTINATION_FIELDS = [
  'setupPhase',
  'splitRecoveryRequired',
  'includedRepoIds',
  'lastTouchedAt',
  'seenPipelineExecutionIds',
  'adhocTransitionSource',
] as const satisfies readonly (keyof WorktreeData)[];

function undoRowField<K extends keyof WorktreeData>(
  next: WorktreeData,
  target: WorktreeData,
  key: K,
  before: WorktreeData,
  written: WorktreeData,
): void {
  if (isDeepStrictEqualData(target[key], written[key])) next[key] = before[key];
}

function undoCompositionFields(
  next: WorktreeData,
  target: WorktreeData,
  before: CompositionSourceFields,
  written: CompositionSourceFields,
): void {
  const branches = { ...target.trackedRepoBaseBranches };
  for (const [key, value] of Object.entries(
    written.trackedRepoBaseBranches ?? {},
  )) {
    if (isDeepStrictEqualData(value, before.trackedRepoBaseBranches?.[key]))
      continue;
    if (branches[key] === value) {
      const previous = before.trackedRepoBaseBranches?.[key];
      if (previous === undefined) delete branches[key];
      else branches[key] = previous;
    }
  }
  next.trackedRepoBaseBranches = Object.keys(branches).length
    ? branches
    : undefined;
  const added =
    written.compatibilitySymlinks?.filter(
      (link) =>
        !before.compatibilitySymlinks?.some((old) =>
          isDeepStrictEqualData(old, link),
        ),
    ) ?? [];
  const links = target.compatibilitySymlinks?.filter(
    (link) => !added.some((own) => isDeepStrictEqualData(own, link)),
  );
  next.compatibilitySymlinks = links?.length
    ? links
    : before.compatibilitySymlinks === undefined
      ? undefined
      : links;
}

/** Each owned value is compared before it is undone; competing edits survive. */
export function applyCompositionJoinUndoTo(
  rows: WorktreeData[],
  decision: CompositionJoinUndoDecision,
): WorktreeData[] {
  const target = rows.find((row) => isSameIncarnation(row, decision.worktree));
  if (!target) return rows;
  const next = { ...target };
  undoCompositionFields(next, target, decision.before, decision.written);
  for (const key of DESTINATION_FIELDS)
    undoRowField(next, target, key, decision.before, decision.written);
  return isDeepStrictEqualData(next, target)
    ? rows
    : rows.map((row) => (row === target ? next : row));
}

export function applyCompositionSourceRecordTo(
  rows: WorktreeData[],
  decision: CompositionSourceRecordDecision,
): CompositionListPass<CompositionSourceRecorded> {
  const target = rows.find((row) => row.id === decision.worktree.id);
  if (!target)
    throw refuse('not-found', `Worktree ${decision.worktree.id} not found`);
  if (!isSameIncarnation(target, decision.worktree))
    throw compositionIdentityChanged(target.id);
  const before: CompositionSourceFields = {
    trackedRepoBaseBranches: target.trackedRepoBaseBranches,
    compatibilitySymlinks: target.compatibilitySymlinks,
    adhocTransitionSource: target.adhocTransitionSource,
  };
  const written: CompositionSourceFields = {
    trackedRepoBaseBranches: decision.trackedBranches
      ? {
          ...target.trackedRepoBaseBranches,
          ...decision.trackedBranches,
        }
      : target.trackedRepoBaseBranches,
    compatibilitySymlinks: [
      ...(target.compatibilitySymlinks ?? []),
      ...decision.compatibilitySymlinks.filter(
        (link) =>
          !target.compatibilitySymlinks?.some((current) =>
            isDeepStrictEqualData(current, link),
          ),
      ),
    ],
    adhocTransitionSource: decision.transition,
  };
  return {
    worktrees: rows.map((row) =>
      row === target ? { ...row, ...written } : row,
    ),
    recorded: { before, written },
  };
}

/** Each owned value is compared before it is undone; competing edits survive. */
export function applyCompositionSourceUndoTo(
  rows: WorktreeData[],
  decision: CompositionSourceUndoDecision,
): WorktreeData[] {
  const target = rows.find((row) => isSameIncarnation(row, decision.worktree));
  if (!target) return rows;
  const next = { ...target };
  undoCompositionFields(next, target, decision.before, decision.written);
  if (
    isDeepStrictEqualData(
      target.adhocTransitionSource,
      decision.written.adhocTransitionSource,
    )
  )
    next.adhocTransitionSource = decision.before.adhocTransitionSource;
  return isDeepStrictEqualData(next, target)
    ? rows
    : rows.map((row) => (row === target ? next : row));
}

export function applyCompositionRowsRestoreTo(
  rows: WorktreeData[],
  decision: CompositionRowsRestoreDecision,
): WorktreeData[] {
  const missing: WorktreeData[] = [];
  for (const removed of decision.rows) {
    const existing = rows.find((row) => row.id === removed.id);
    if (existing && !isSameIncarnation(existing, removed))
      throw compositionIdentityChanged(removed.id);
    if (!existing) missing.push(removed);
  }
  if (!missing.length) return rows;
  const restored = [...rows];
  for (const removed of missing) {
    const order = decision.order ?? [];
    const position = order.indexOf(removed.id);
    const nextId =
      position < 0
        ? undefined
        : order
            .slice(position + 1)
            .find((id) => restored.some((row) => row.id === id));
    const nextIndex =
      nextId === undefined
        ? -1
        : restored.findIndex((row) => row.id === nextId);
    restored.splice(nextIndex < 0 ? restored.length : nextIndex, 0, removed);
  }
  return restored;
}

/** Whether a composition removal removes `row`. */
export function removesCompositionRow(
  row: WorktreeData,
  decision: CompositionRowRemoveDecision,
): boolean {
  if (row.id !== decision.worktree.id) return false;
  if (!isSameIncarnation(row, decision.worktree))
    throw compositionIdentityChanged(row.id);
  return true;
}

/** A temporary project never takes over an existing or unproven list. */
export function admitTemporaryCompositionList(
  workspaceId: string,
  authority: W5RecordReadAuthority | undefined,
): void {
  if (authority !== 'absent')
    throw refuse(
      'identity-changed',
      `Project ${workspaceId} already has a worktree list`,
    );
}

function requireManifest(
  workspaceId: string,
  authority: W5RecordReadAuthority,
): void {
  if (authority === 'absent')
    throw refuse('not-found', `Project ${workspaceId} not found`);
}

/** Changes `config` in place; returns whether it removed a repository. */
export function applyCompositionRepositoriesUndoTo(
  workspaceId: string,
  config: WorkspaceConfigFile,
  authority: W5RecordReadAuthority,
  decision: CompositionRepositoriesUndoDecision,
): boolean {
  requireManifest(workspaceId, authority);
  const remaining = config.repos.filter(
    (repo) =>
      !decision.repositories.some(
        (own) => own.id === repo.id && own.repoPath === repo.repoPath,
      ),
  );
  if (remaining.length === config.repos.length) return false;
  config.repos = remaining;
  return true;
}

/** Fills the default `config` of an absent manifest in place. */
export function applyTemporaryCompositionManifestTo(
  workspaceId: string,
  config: WorkspaceConfigFile,
  authority: W5RecordReadAuthority,
  decision: TemporaryCompositionManifestDecision,
): void {
  if (authority !== 'absent')
    throw refuse('identity-changed', `Project ${workspaceId} already exists`);
  const created: WorkspaceConfigFile = {
    version: 1,
    type: 'multi-repo',
    repos: decision.repos,
    temporary: true,
    alwaysShow: false,
    temporarySourceWorkspaceIds: decision.temporarySourceWorkspaceIds,
    temporaryRepoIdentityKeys: decision.temporaryRepoIdentityKeys,
  };
  Object.assign(config, created);
}

/** The checks a promotion makes before it renames the index entry. */
export function admitCompositionPromotion(
  workspaceId: string,
  config: WorkspaceConfigFile,
  authority: W5RecordReadAuthority,
): void {
  requireManifest(workspaceId, authority);
  if (config.type !== 'multi-repo')
    throw refuse(
      'not-found',
      `Project ${workspaceId} is not a multi-repo project`,
    );
  if (config.temporary !== true)
    throw refuse('not-temporary', `Project ${workspaceId} is not temporary`);
}

/** Changes `config` in place, after the index entry was renamed. */
export function applyCompositionPromotionTo(
  config: WorkspaceConfigFile,
  decision: CompositionPromotionDecision,
): void {
  config.sourceRepoPath = decision.sourceRepoPath;
  delete config.temporary;
  delete config.temporarySourceWorkspaceIds;
  delete config.temporaryRepoIdentityKeys;
}

/**
 * The index entries after `decision`, or `null` when the read cannot show
 * what the decision needs: an unreadable index, and for a new entry also a
 * partial one.
 */
export function applyWorkspaceIndexDecisionTo(
  entries: WorkspaceIndexEntry[],
  authority: W5RecordReadAuthority,
  decision: WorkspaceIndexDecision,
): WorkspaceIndexEntry[] | null {
  if (authority === 'unreadable') return null;
  switch (decision.kind) {
    case 'composition.temporary.index': {
      if (authority === 'partial') return null;
      const { entry } = decision;
      if (entries.some((current) => current.id === entry.id))
        throw refuse('identity-changed', `Project ${entry.id} already exists`);
      return [
        ...entries,
        {
          id: entry.id,
          name: entry.name,
          type: entry.type,
          color: entry.color,
          collapsed: entry.collapsed,
          order: entries.length,
        },
      ];
    }
    case 'composition.promote.index': {
      const target = entries.find((entry) => entry.id === decision.workspaceId);
      if (!target || target.type !== 'multi-repo')
        throw refuse(
          'not-found',
          `Project ${decision.workspaceId} is not a multi-repo project`,
        );
      return entries.map((entry) =>
        entry === target ? { ...entry, name: decision.name } : entry,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ownership, seed, Cowork and seen records (W5c2)
// ---------------------------------------------------------------------------

/** The ownership `updateWorkspaceOwnership` writes for `decision`. */
export function applyWorkspaceOwnerDecisionTo(
  decision: WorkspaceOwnerDecision,
): {
  owner?: WorkspaceOwnerBinding;
  ownershipTransfer?: WorkspaceOwnershipTransfer;
} {
  return {
    owner: decision.owner,
    ownershipTransfer: decision.ownershipTransfer,
  };
}

/**
 * The binding a re-claim holds and its replacement. Another organization,
 * project or instance holds nothing; a fence that is not behind is kept.
 */
export function decideOrganizationOwnerRefresh(
  current: WorkspaceOwnershipSnapshot,
  decision: OrganizationOwnerRefreshDecision,
): {
  held?: OrganizationOwnerBinding;
  replacement: WorkspaceOwnerDecision | null;
} {
  const { owner } = decision;
  const persisted =
    current.owner?.type === 'organization' ? current.owner : undefined;
  if (
    !persisted ||
    persisted.organizationId !== owner.organizationId ||
    persisted.projectId !== owner.projectId ||
    persisted.instanceId !== owner.instanceId
  )
    return { replacement: null };
  if (persisted.bindingGeneration >= owner.bindingGeneration)
    return { held: persisted, replacement: null };
  return {
    held: owner,
    replacement: {
      kind: 'ownership.owner',
      owner,
      ownershipTransfer: current.ownershipTransfer,
    },
  };
}

/** Rebind persisted executable hooks after their workspace changes owner. */
export function rebindHookExecutionContexts(
  hooks: WorkspaceConfigFile['hooks'],
  previousContext: string,
  nextContext: string,
  scope: string,
): string[] {
  if (hooks === undefined) return [];
  const rebound: string[] = [];
  for (const [trigger, actions] of Object.entries(hooks)) {
    const executableActions = actions ?? [];
    for (let index = 0; index < executableActions.length; index += 1) {
      const action = executableActions[index];
      if (action === undefined) continue;
      if (action.type !== 'pipeline' && action.type !== 'chat') continue;
      // A plugin-selection overlay carries no binding of its own.
      if (
        action.type === 'chat' &&
        action.localPluginSelectionOverlay === true &&
        action.localExecutionContextOverlay !== true
      )
        continue;
      if (
        action.executionContext !== undefined &&
        action.executionContext !== previousContext
      )
        continue;
      action.executionContext = nextContext;
      rebound.push(`${scope}:${trigger}:${index}`);
    }
  }
  return rebound;
}

/** Changes `config`'s hooks in place; returns the ids of the rebound hooks. */
export function applyHookExecutionContextsRebindTo(
  config: WorkspaceConfigFile,
  decision: HookExecutionContextsRebindDecision,
): string[] {
  const ids = rebindHookExecutionContexts(
    config.hooks,
    decision.previousContext,
    decision.nextContext,
    'workspace-root',
  );
  for (const repo of config.repos)
    ids.push(
      ...rebindHookExecutionContexts(
        repo.hooks,
        decision.previousContext,
        decision.nextContext,
        `workspace-repo:${repo.id}`,
      ),
    );
  return ids;
}

/** What the release learns from the manifest read in its queue. */
export function checkAdoptedWorkspaceRelease(
  config: WorkspaceConfigFile,
  read: W5ManifestRead,
  decision: AdoptedWorkspaceReleaseDecision,
): AdoptedWorkspaceReleaseCheck {
  if (read.authority === 'absent') return 'absent';
  // An owner that cannot be read is not proof of this binding.
  if (read.ownerMalformed) return 'owner-unreadable';
  const owner = config.owner;
  return owner?.type === 'organization' &&
    owner.instanceId === decision.instanceId
    ? 'bound'
    : 'bound-elsewhere';
}

/** The entries without this workspace's, in place; `null` when it is not there. */
export function applyAdoptedWorkspaceIndexReleaseTo(
  entries: WorkspaceIndexEntry[],
  decision: AdoptedWorkspaceIndexReleaseDecision,
): WorkspaceIndexEntry[] | null {
  const remaining = entries.filter(
    (entry) => entry.id !== decision.workspaceId,
  );
  return remaining.length === entries.length ? null : remaining;
}

/** Changes `config` in place when it records the policy. */
export function applyOrganizationPrivateMemoryTo(
  config: WorkspaceConfigFile,
  read: W5ManifestRead,
  decision: OrganizationPrivateMemoryDecision,
): OrganizationPrivateMemoryStatus {
  if (
    read.authority === 'absent' ||
    read.memoryMalformed ||
    read.ownerMalformed
  )
    return 'refused';
  const owner = config.owner;
  if (
    owner?.type !== 'organization' ||
    owner.organizationId !== decision.organizationId ||
    owner.projectId !== decision.projectId
  )
    return 'refused';
  if (
    config.privateMemory === decision.privateMemory &&
    config.privateMemoryManagedBy === 'organization'
  )
    return 'unchanged';
  config.privateMemory = decision.privateMemory;
  config.privateMemoryManagedBy = 'organization';
  return 'recorded';
}

/** The bytes an index seed publishes. */
export function workspaceIndexSeedDocument(): string {
  return JSON.stringify({ version: 1, workspaces: [] }, null, 2);
}

export type CoworkWorkspaceRecordRefusal =
  | 'invalid-request'
  | 'not-found'
  | 'index-unavailable'
  | 'configuration-unavailable'
  | 'identity-changed'
  | 'activity-unavailable';
export class CoworkWorkspaceRecordRefusedError extends Error {
  constructor(
    readonly reason: CoworkWorkspaceRecordRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'CoworkWorkspaceRecordRefusedError';
  }
}
function refuseCowork(
  reason: CoworkWorkspaceRecordRefusal,
  message: string,
): never {
  throw new CoworkWorkspaceRecordRefusedError(reason, message);
}
const COWORK_IDENTITY_IN_USE = 'The local workspace id is already in use';
function coworkConfigurationUnavailable(name: string): never {
  refuseCowork(
    'configuration-unavailable',
    `The ${name} project configuration is unavailable`,
  );
}

/** Refuses an index read that cannot show every entry. */
export function admitCoworkIndex(authority: W5RecordReadAuthority): void {
  if (authority !== 'ok' && authority !== 'absent') {
    refuseCowork('index-unavailable', 'The workspace index is unavailable');
  }
}

export function coworkConfigFor(item: CoworkSidebarItem): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'cowork',
    repos: [],
    externalPath: item.externalPath,
    cowork: item.cowork,
    defaultPluginSelections: item.defaultPluginSelections,
    installedFromTemplateExternalId: item.installedFromTemplateExternalId,
    seededFromBlueprintExternalId: item.seededFromBlueprintExternalId,
    owner: item.owner,
  };
}
export function coworkEntryFor(item: CoworkSidebarItem): WorkspaceIndexEntry {
  return {
    id: item.id,
    name: item.name,
    type: 'cowork',
    color: item.color,
    collapsed: item.collapsed,
    order: item.order,
  };
}
export function projectedCoworkItem(
  entry: WorkspaceIndexEntry,
  config: WorkspaceConfigFile,
): CoworkSidebarItem {
  return { ...config, ...entry, type: 'cowork' };
}
export function sameCoworkOwner(
  owner: WorkspaceOwnerBinding | undefined,
  expected: WorkspaceOwnerBinding,
): boolean {
  return (
    owner?.type === 'organization' &&
    expected.type === 'organization' &&
    owner.organizationId === expected.organizationId &&
    owner.projectId === expected.projectId
  );
}

export const COWORK_FIELDS = [
  'createdAt',
  'description',
  'defaultModel',
  'defaultPresetId',
  'presets',
  'archiveRetentionDays',
  'autoArchiveDays',
  'starterPrompts',
  'startPage',
] as const satisfies ReadonlyArray<keyof CoworkWorkspaceSettings>;

/**
 * The Cowork settings with the unknown fields of the raw file's `cowork`
 * (`undefined` when the raw read was not authoritative); sets them on
 * `config` when it has settings. A known field the normalization dropped as
 * malformed stays dropped.
 */
export function withUnknownCoworkFields(
  rawCowork: unknown,
  config: WorkspaceConfigFile,
): CoworkWorkspaceSettings {
  const known: ReadonlySet<string> = new Set(COWORK_FIELDS);
  const unknown =
    isRecord(rawCowork) && !Array.isArray(rawCowork)
      ? Object.fromEntries(
          Object.entries(rawCowork).filter(([key]) => !known.has(key)),
        )
      : {};
  const settings: CoworkWorkspaceSettings = { ...unknown, ...config.cowork };
  if (config.cowork !== undefined) config.cowork = settings;
  return settings;
}

/** The provisioned entry, if any; another type at the id is refused. */
export function admitCoworkProvisionEntry(
  entries: WorkspaceIndexEntry[],
  decision: CoworkProvisionDecision,
): WorkspaceIndexEntry | undefined {
  const entry = entries.find(
    (candidate) => candidate.id === decision.workspaceId,
  );
  if (entry && entry.type !== 'cowork')
    coworkConfigurationUnavailable(decision.name);
  return entry;
}

/** What the provisioning index update read under its queue. */
export interface CoworkIndexContext {
  entry: WorkspaceIndexEntry | undefined;
  count: number;
  /** The palette color for a new entry at `count`. */
  color: string;
}

/** Refuses an existing manifest that is not Cowork or whose owner is unreadable. */
export function admitCoworkProvisionManifest(
  config: WorkspaceConfigFile,
  read: W5ManifestRead,
  decision: CoworkProvisionDecision,
): void {
  if (config.type !== 'cowork' || read.ownerMalformed)
    coworkConfigurationUnavailable(decision.name);
}

/**
 * One pass of the provisioning manifest update, changing `config` in place.
 * An existing manifest is admitted, and its unknown Cowork fields restored,
 * before this pass.
 */
export function applyCoworkProvisionManifestTo(
  config: WorkspaceConfigFile,
  read: W5ManifestRead,
  index: CoworkIndexContext,
  decision: CoworkProvisionDecision,
): CoworkProvisionManifestPass {
  const { entry } = index;
  const initial: CoworkSidebarItem = {
    id: decision.workspaceId,
    name: decision.name,
    type: 'cowork',
    color: index.color,
    collapsed: false,
    order: index.count,
    cowork: {
      createdAt: decision.createdAt,
      archiveRetentionDays: 7,
    },
    ...(decision.owner ? { owner: decision.owner } : {}),
  };
  if (read.authority !== 'absent') {
    const item = projectedCoworkItem(entry ?? coworkEntryFor(initial), config);
    const same =
      decision.owner === undefined ||
      config.owner === decision.owner ||
      (sameCoworkOwner(config.owner, decision.owner) &&
        config.owner?.type === 'organization' &&
        decision.owner.type === 'organization' &&
        config.owner.instanceId === decision.owner.instanceId &&
        config.owner.bindingGeneration === decision.owner.bindingGeneration);
    if (same) return { item, changed: false, scaffold: false };
    config.owner = decision.owner;
    config.ownershipTransfer = undefined;
    item.owner = decision.owner;
    return { item, changed: true, scaffold: false };
  }
  if (entry && !decision.owner)
    return {
      item: { ...entry, type: 'cowork' },
      changed: false,
      scaffold: false,
    };
  const item: CoworkSidebarItem = {
    ...initial,
    ...entry,
    type: 'cowork',
  };
  Object.assign(config, coworkConfigFor(item));
  return {
    item,
    changed: true,
    scaffold: true,
    deferManifest: !decision.owner,
  };
}

/** The provisioning outcome, and the entries when it publishes a new one. */
export function applyCoworkProvisionIndexTo(
  entries: WorkspaceIndexEntry[],
  entry: WorkspaceIndexEntry | undefined,
  pass: CoworkProvisionManifestPass,
  decision: CoworkProvisionDecision,
): { result: CoworkProvisionOutcome; entries?: WorkspaceIndexEntry[] } {
  const publish = decision.publishToIndex && !entry;
  return {
    result: {
      item: pass.item,
      ...(pass.deferManifest && publish ? { deferredManifest: pass.item } : {}),
      notify:
        decision.publishToIndex &&
        (publish || (pass.changed && !pass.scaffold)),
    },
    ...(publish ? { entries: [...entries, coworkEntryFor(pass.item)] } : {}),
  };
}

/** Fills the default `config` of an absent manifest in place. */
export function applyCoworkProvisionManifestCreateTo(
  config: WorkspaceConfigFile,
  read: W5ManifestRead,
  decision: CoworkProvisionManifestDecision,
): void {
  if (read.authority !== 'absent')
    refuseCowork('identity-changed', COWORK_IDENTITY_IN_USE);
  Object.assign(config, coworkConfigFor(decision.item));
}

/**
 * The migration identity: the candidate, or the first free suffix past
 * entries of another type. `entries` is absent when a Cowork entry already
 * holds it.
 */
export function allocateCoworkMigrationTo(
  entries: WorkspaceIndexEntry[],
  decision: CoworkMigrationDecision,
  /** The palette color for a new entry at the end of `entries`. */
  nextColor: string,
): { id: string; entries?: WorkspaceIndexEntry[] } {
  let id = decision.candidateId;
  let suffix = 2;
  let entry = entries.find((candidate) => candidate.id === id);
  while (entry && entry.type !== 'cowork') {
    id = `${decision.candidateId}-${suffix++}`;
    entry = entries.find((candidate) => candidate.id === id);
  }
  if (entry) return { id };
  const item: CoworkSidebarItem = {
    id,
    name: decision.name,
    type: 'cowork',
    color: decision.color ?? nextColor,
    collapsed: false,
    order: entries.length,
    cowork: decision.cowork,
  };
  return { id, entries: [...entries, coworkEntryFor(item)] };
}

/** Changes `config` in place; `current` is its settings with unknown fields restored. */
export function applyCoworkMigrationManifestTo(
  config: WorkspaceConfigFile,
  current: CoworkWorkspaceSettings,
  decision: CoworkMigrationManifestDecision,
): void {
  const next = { ...current, ...decision.cowork };
  for (const key of COWORK_FIELDS)
    if (decision.cowork?.[key] === undefined) delete next[key];
  config.type = 'cowork';
  config.repos = [];
  config.cowork = Object.keys(next).length > 0 ? next : undefined;
}

/** The list after `decision`, and what its matching row newly marked seen. */
export function applyPipelineResultsSeenTo(
  rows: WorktreeData[],
  decision: PipelineResultsSeenDecision,
): { worktrees: WorktreeData[]; newlySeen?: string[] } {
  let changed = false;
  let newlySeen: string[] | undefined;
  const next = rows.map((row) => {
    if (!isSameIncarnation(row, decision.worktree)) return row;
    const outcome = markWorktreePipelineResultsSeen(row, decision);
    newlySeen = outcome.newlySeen;
    changed ||= outcome.worktree !== row;
    return outcome.worktree;
  });
  return { worktrees: changed ? next : rows, newlySeen };
}

/** The well-formed execution ids, in order. */
export function pipelineExecutionIds(
  ids: readonly unknown[] | undefined,
): string[] {
  return (ids ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

/**
 * `internal.worktree.pipelineResults.markSeen` (CAN-3821): applies a seen
 * change to one committed row. Unseen executions are removed in place, newly
 * seen ones are appended in order, and the field is dropped when no execution
 * is left, as the renderer stores it. The caller writes the row under the
 * worktree list lock and announces `newlySeen` only after that commit. It
 * takes no client revision (D9).
 */
export function markWorktreePipelineResultsSeen(
  worktree: WorktreeData,
  change: { seen: readonly string[]; unseen: readonly string[] },
): { worktree: WorktreeData; newlySeen: string[] } {
  const current = pipelineExecutionIds(worktree.seenPipelineExecutionIds);
  const unseen = new Set(change.unseen);
  const kept = current.filter((id) => !unseen.has(id));
  const keptSet = new Set(kept);
  const newlySeen: string[] = [];
  for (const id of pipelineExecutionIds(change.seen)) {
    if (keptSet.has(id)) continue;
    keptSet.add(id);
    newlySeen.push(id);
  }
  const next = [...kept, ...newlySeen];
  const unchanged =
    next.length === current.length &&
    next.every((id, index) => id === current[index]) &&
    (next.length > 0 || worktree.seenPipelineExecutionIds === undefined);
  if (unchanged) return { worktree, newlySeen };
  const updated: WorktreeData = { ...worktree };
  if (next.length > 0) updated.seenPipelineExecutionIds = next;
  else delete updated.seenPipelineExecutionIds;
  return { worktree: updated, newlySeen };
}
