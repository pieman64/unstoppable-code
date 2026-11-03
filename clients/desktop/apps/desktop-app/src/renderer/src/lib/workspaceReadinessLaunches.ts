import type {
  SidebarItem,
  WorkspaceReadinessIssue,
  WorkspaceReadinessIssueCode,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type { ChatTab } from '@/stores/chat/types';
import { workspaceReadinessIssueKey } from '@/lib/workspaceReadinessIssueKey';
import { shouldShowWorktreeMergedState } from '@/lib/worktreeMergedState';

/**
 * Store-free helpers for launched readiness fixes (CAN-5500). A record is a
 * renderer UI projection of "this readiness issue was launched into that
 * worktree chat"; the worktree, PR, chat and audit data it points at stay
 * main-owned and authoritative. A record proves a destination exists, never
 * that the agent succeeded.
 */
export interface LaunchedReadinessFix {
  workspaceId: string;
  /** `workspaceReadinessIssueKey(issue)`. */
  issueKey: string;
  issueCode: WorkspaceReadinessIssueCode;
  /** Audited worktree the fix branched from; absent for the reference checkout. */
  baseWorktreeId?: string;
  /** The launched fix worktree. */
  worktreeId: string;
  chatId: string;
  launchedAt: string;
}

export const WORKSPACE_READINESS_LAUNCHES_STORAGE_KEY =
  'canopy.workspaceReadiness.launchedFixes.v1';

const STORAGE_VERSION = 1;

const ISSUE_CODES: readonly WorkspaceReadinessIssueCode[] = [
  'configure-scripts',
  'configure-hooks',
  'configure-agent-instructions',
  'recovery-required',
];

function isIssueCode(value: string): value is WorkspaceReadinessIssueCode {
  return ISSUE_CODES.some((code) => code === value);
}

export type LaunchedReadinessFixes = Readonly<
  Record<string, LaunchedReadinessFix>
>;

/**
 * Scoped identity of one launch: workspace, audit target and issue. A JSON
 * tuple cannot collide on delimiters, and `null` for the reference checkout
 * cannot collide with any worktree id.
 */
export function workspaceReadinessLaunchKey(
  workspaceId: string,
  baseWorktreeId: string | undefined,
  issueKey: string,
): string {
  return JSON.stringify([workspaceId, baseWorktreeId ?? null, issueKey]);
}

export function workspaceReadinessLaunchKeyForIssue(
  workspaceId: string,
  baseWorktreeId: string | undefined,
  issue: WorkspaceReadinessIssue,
): string {
  return workspaceReadinessLaunchKey(
    workspaceId,
    baseWorktreeId,
    workspaceReadinessIssueKey(issue),
  );
}

export function launchedReadinessFixKey(record: LaunchedReadinessFix): string {
  return workspaceReadinessLaunchKey(
    record.workspaceId,
    record.baseWorktreeId,
    record.issueKey,
  );
}

/** Whether two records are the same launch, not merely the same issue. */
export function isSameLaunchedReadinessFix(
  left: LaunchedReadinessFix,
  right: LaunchedReadinessFix,
): boolean {
  return (
    launchedReadinessFixKey(left) === launchedReadinessFixKey(right) &&
    left.worktreeId === right.worktreeId &&
    left.chatId === right.chatId &&
    left.launchedAt === right.launchedAt
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): LaunchedReadinessFix | null {
  if (!isRecordObject(value)) return null;
  const {
    workspaceId,
    issueKey,
    issueCode,
    baseWorktreeId,
    worktreeId,
    chatId,
    launchedAt,
  } = value;
  if (
    !nonEmptyString(workspaceId) ||
    !nonEmptyString(issueKey) ||
    !nonEmptyString(issueCode) ||
    !nonEmptyString(worktreeId) ||
    !nonEmptyString(chatId) ||
    !nonEmptyString(launchedAt)
  ) {
    return null;
  }
  if (!isIssueCode(issueCode)) return null;
  if (baseWorktreeId !== undefined && !nonEmptyString(baseWorktreeId)) {
    return null;
  }
  if (Number.isNaN(Date.parse(launchedAt))) return null;
  return {
    workspaceId,
    issueKey,
    issueCode,
    ...(baseWorktreeId === undefined ? {} : { baseWorktreeId }),
    worktreeId,
    chatId,
    launchedAt,
  };
}

/**
 * Reads the stored container. Malformed JSON, an unsupported version or a bad
 * container yields no records; malformed records are skipped individually.
 * Never throws.
 */
export function parseLaunchedReadinessFixes(
  raw: string | null,
): LaunchedReadinessFixes {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (
    !isRecordObject(parsed) ||
    parsed.version !== STORAGE_VERSION ||
    !Array.isArray(parsed.records)
  ) {
    return {};
  }
  const records: Record<string, LaunchedReadinessFix> = {};
  for (const entry of parsed.records) {
    const record = parseRecord(entry);
    if (record) records[launchedReadinessFixKey(record)] = record;
  }
  return records;
}

export function serializeLaunchedReadinessFixes(
  records: LaunchedReadinessFixes,
): string {
  return JSON.stringify({
    version: STORAGE_VERSION,
    records: Object.values(records),
  });
}

/** Records launched from one audit target, keyed like the store. */
export function launchedReadinessFixesForTarget(
  records: LaunchedReadinessFixes,
  workspaceId: string,
  baseWorktreeId: string | undefined,
): LaunchedReadinessFix[] {
  return Object.values(records).filter(
    (record) =>
      record.workspaceId === workspaceId &&
      record.baseWorktreeId === baseWorktreeId,
  );
}

/**
 * Records a successful, complete audit of their exact target no longer
 * reports. Pass the snapshot taken when the audit began so a launch written
 * during the audit is never judged against an older result.
 */
export function resolvedLaunchedReadinessFixes(
  snapshot: readonly LaunchedReadinessFix[],
  reportedIssues: readonly WorkspaceReadinessIssue[],
): LaunchedReadinessFix[] {
  const reported = new Set(reportedIssues.map(workspaceReadinessIssueKey));
  return snapshot.filter((record) => !reported.has(record.issueKey));
}

export interface WorkspaceReadinessLaunchInventory {
  projects: readonly SidebarItem[];
  /** Last successful list before optimistic renderer removals. */
  completeProjects?: readonly SidebarItem[];
  /** When that read began; older reads cannot retire a newer launch. */
  readStartedAt?: number;
  /** The latest projects list read succeeded and no reload is in flight. */
  complete: boolean;
  /** Workspaces whose last load failed; their rows are last-known, not current. */
  failedWorkspaceIds: ReadonlySet<string>;
  /** Live PR status by `${workspaceId}/${worktreeId}`; absent falls back to the persisted snapshot. */
  prStatuses: Readonly<Record<string, WorktreePrStatus | null>>;
}

export function findLaunchWorktree(
  projects: readonly SidebarItem[],
  workspaceId: string,
  worktreeId: string,
): WorktreeData | undefined {
  const workspace = projects.find((project) => project.id === workspaceId);
  if (!workspace || workspace.type === 'cowork') return undefined;
  return workspace.worktrees.find((worktree) => worktree.id === worktreeId);
}

/**
 * Whether authoritative evidence retires a record: its workspace or fix
 * worktree is absent from a complete list, or the fix worktree merged. A
 * loading, failed or partial list never establishes absence.
 */
export function isLaunchedReadinessFixObsolete(
  record: LaunchedReadinessFix,
  inventory: WorkspaceReadinessLaunchInventory,
): boolean {
  const workspace = inventory.projects.find(
    (project) => project.id === record.workspaceId,
  );
  const listed =
    workspace && workspace.type !== 'cowork'
      ? workspace.worktrees.find((entry) => entry.id === record.worktreeId)
      : undefined;
  if (listed) {
    const live = inventory.prStatuses[`${record.workspaceId}/${listed.id}`];
    return shouldShowWorktreeMergedState(
      listed.status,
      live === undefined ? listed.lastKnownPrStatus : live,
    );
  }
  return (
    inventory.complete &&
    !inventory.failedWorkspaceIds.has(record.workspaceId) &&
    (inventory.readStartedAt === undefined ||
      inventory.readStartedAt > Date.parse(record.launchedAt)) &&
    findLaunchWorktree(
      inventory.completeProjects ?? inventory.projects,
      record.workspaceId,
      record.worktreeId,
    ) === undefined
  );
}

export type LaunchedReadinessFixStatus =
  | 'in-progress'
  | 'ready-to-review'
  | 'unknown'
  | 'needs-attention'
  | 'chat-missing';

export interface LaunchedReadinessFixStatusInput {
  worktree: Pick<WorktreeData, 'setupPhase'> | undefined;
  tab:
    | Pick<
        ChatTab,
        | 'status'
        | 'queuedMessages'
        | 'sendingLease'
        | 'pendingTurn'
        | 'pendingUserMessages'
      >
    | undefined;
  /** The fix worktree's chat tabs have hydrated in this renderer. */
  chatsHydrated: boolean;
  /** The launcher's send for this record has not settled yet. */
  sendPending: boolean;
  /** The launcher's send for this record failed. */
  sendFailed: boolean;
}

/**
 * Display state for a retained record. Persisted identity is trusted; running
 * status is not, so an unhydrated chat after a restart reads as `unknown`
 * rather than idle.
 */
export function resolveLaunchedReadinessFixStatus({
  worktree,
  tab,
  chatsHydrated,
  sendPending,
  sendFailed,
}: LaunchedReadinessFixStatusInput): LaunchedReadinessFixStatus {
  if (sendFailed || tab?.status === 'error') return 'needs-attention';
  if (sendPending || worktree?.setupPhase === 'git-pending') {
    return 'in-progress';
  }
  if (tab) {
    const working =
      tab.status === 'streaming' ||
      tab.queuedMessages.length > 0 ||
      tab.sendingLease?.state === 'pending' ||
      tab.pendingTurn !== undefined ||
      (tab.pendingUserMessages?.length ?? 0) > 0;
    if (working) return 'in-progress';
    return chatsHydrated ? 'ready-to-review' : 'unknown';
  }
  return chatsHydrated ? 'chat-missing' : 'unknown';
}

/** Short noun naming what a launched fix configures. */
export function workspaceReadinessLaunchNoun(
  issue: Pick<WorkspaceReadinessIssue, 'code' | 'title'>,
): string {
  switch (issue.code) {
    case 'configure-agent-instructions':
      return 'Agent instructions';
    case 'configure-scripts':
      return 'Setup and launch scripts';
    case 'configure-hooks':
      return 'Repository hooks';
    default:
      return issue.title;
  }
}

/** The worktree's nonempty label, otherwise its branch name. */
export function launchDestinationLabel(
  worktree: Pick<WorktreeData, 'label' | 'branchName'> | undefined,
): string | undefined {
  const label = worktree?.label?.trim();
  if (label) return label;
  const branch = worktree?.branchName.trim();
  return branch ? branch : undefined;
}
