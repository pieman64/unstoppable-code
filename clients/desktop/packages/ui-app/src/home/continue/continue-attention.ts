/**
 * Home Continue attention model (CAN-4958). Hosts normalize their own state
 * into {@link ContinueAttentionItem}s; these pure helpers deduplicate, rank,
 * cap, and describe them so desktop Home and Portal New Task present the same
 * order and copy. Nothing here knows which host produced an item.
 */

/** Attention kinds, in presentation priority order (highest first). */
export const CONTINUE_ATTENTION_KINDS = [
  'question',
  'tool-approval',
  'plan-review',
  'unread',
] as const;

export type ContinueAttentionKind = (typeof CONTINUE_ATTENTION_KINDS)[number];

/** Kinds that need the user's input, as opposed to unread results. */
export type ContinueNeedsInputKind = Exclude<ContinueAttentionKind, 'unread'>;

/**
 * Where a row leads. A chat target names one exact chat; a worktree target is
 * an aggregate fallback for when the host cannot yet identify the chats, and
 * never carries a chat id.
 */
export type ContinueAttentionTarget =
  | {
      readonly kind: 'chat';
      readonly workspaceId: string;
      readonly worktreeId: string;
      readonly chatId: string;
    }
  | {
      readonly kind: 'worktree';
      readonly workspaceId: string;
      readonly worktreeId: string;
    };

export interface ContinueAttentionItem {
  readonly kind: ContinueAttentionKind;
  readonly target: ContinueAttentionTarget;
  readonly workspaceName: string;
  readonly worktreeName: string;
  /** Display title of the chat; chat targets only. */
  readonly chatTitle?: string;
  /** Epoch milliseconds of the event behind the item, when known. */
  readonly eventAt?: number;
  /**
   * Unread items only: the host has evidence that the chat's turn finished.
   * Without it, copy says the chat "has unread updates" rather than claiming
   * it finished.
   */
  readonly completed?: boolean;
}

/** The startup "Last viewed" destination, when the host persists one. */
export interface ContinueLastViewed {
  readonly workspaceId: string;
  /** Absent for destinations that are not a worktree (a cowork chat). */
  readonly worktreeId?: string;
  readonly destinationName: string;
  readonly workspaceName: string;
  /**
   * What the host already knows about the destination ("Agent working",
   * "New activity"), or null. Hosts without that state omit it.
   */
  readonly activity?: string | null;
  /**
   * The chat the host associates with the destination, shown as secondary
   * text. Hosts omit it when unknown or when it is already the destination.
   */
  readonly chatTitle?: string;
  /**
   * The worktree's branch, shown as secondary text when the chat title names
   * the destination. Hosts omit it for labeled worktrees and generated
   * default branches.
   */
  readonly worktreeName?: string;
}

export interface LastViewedNameInput {
  /** The user's explicit worktree label. */
  readonly worktreeLabel?: string;
  /** The chat the host associates with the destination. */
  readonly chatTitle?: string;
  /** An informative branch name; hosts omit generated default branches. */
  readonly branchName?: string;
  /** The host's existing display name when nothing else is usable. */
  readonly fallbackName: string;
}

export type LastViewedNames = Pick<
  ContinueLastViewed,
  'destinationName' | 'chatTitle' | 'worktreeName'
>;

function usableName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Names a worktree Last viewed destination: its label, else its chat title,
 * else its branch, else the host fallback. The chat title and branch appear
 * as secondary text only when they add something the destination does not
 * already say.
 */
export function resolveLastViewedNames({
  worktreeLabel,
  chatTitle,
  branchName,
  fallbackName,
}: LastViewedNameInput): LastViewedNames {
  const label = usableName(worktreeLabel);
  const title = usableName(chatTitle);
  const branch = usableName(branchName);
  const destinationName = label ?? title ?? branch ?? fallbackName.trim();
  const titleIsDestination = label === undefined && title !== undefined;
  return {
    destinationName,
    ...(title !== undefined && title !== destinationName
      ? { chatTitle: title }
      : {}),
    ...(titleIsDestination && branch !== undefined && branch !== title
      ? { worktreeName: branch }
      : {}),
  };
}

/**
 * The worktree a single named interrupted chat belongs to. While that row is
 * visible, a Last viewed offer for the same workspace and worktree is merged
 * into it rather than shown again.
 */
export interface ContinueInterruptedTarget {
  readonly workspaceId: string;
  readonly worktreeId: string;
}

const KIND_PRIORITY: Readonly<Record<ContinueAttentionKind, number>> = {
  question: 0,
  'tool-approval': 1,
  'plan-review': 2,
  unread: 3,
};

/** How many unread chat rows show before an overflow link takes over. */
export const CONTINUE_UNREAD_ROW_LIMIT = 3;

/** Stable identity of a target; chat ids alone are not unique across worktrees. */
export function continueAttentionTargetKey(
  target: ContinueAttentionTarget,
): string {
  const base = `${target.workspaceId}\u0000${target.worktreeId}`;
  return target.kind === 'chat'
    ? `chat\u0000${base}\u0000${target.chatId}`
    : `worktree\u0000${base}`;
}

function validEventAt(item: ContinueAttentionItem): number | undefined {
  return item.eventAt !== undefined && Number.isFinite(item.eventAt)
    ? item.eventAt
    : undefined;
}

function compareItems(
  left: ContinueAttentionItem,
  right: ContinueAttentionItem,
): number {
  const byKind = KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind];
  if (byKind !== 0) return byKind;
  const leftAt = validEventAt(left);
  const rightAt = validEventAt(right);
  if (leftAt !== rightAt) {
    // Known timestamps first, newest first; never substitute render time.
    if (leftAt === undefined) return 1;
    if (rightAt === undefined) return -1;
    return rightAt - leftAt;
  }
  const leftKey = continueAttentionTargetKey(left.target);
  const rightKey = continueAttentionTargetKey(right.target);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/** Whether `candidate` should replace `current` for the same target. */
function supersedes(
  candidate: ContinueAttentionItem,
  current: ContinueAttentionItem,
): boolean {
  const byKind = KIND_PRIORITY[candidate.kind] - KIND_PRIORITY[current.kind];
  if (byKind !== 0) return byKind < 0;
  const candidateAt = validEventAt(candidate);
  const currentAt = validEventAt(current);
  if (candidateAt === undefined) return false;
  return currentAt === undefined || candidateAt > currentAt;
}

/**
 * One row per target, keeping its highest-priority kind (newest event among
 * duplicates of that kind), sorted by kind priority, then event time
 * descending, then identity. Hosts filter ineligible items before calling.
 */
export function rankContinueAttention(
  items: readonly ContinueAttentionItem[],
): ContinueAttentionItem[] {
  const byTarget = new Map<string, ContinueAttentionItem>();
  for (const item of items) {
    const key = continueAttentionTargetKey(item.target);
    const current = byTarget.get(key);
    if (current === undefined || supersedes(item, current)) {
      byTarget.set(key, item);
    }
  }
  return Array.from(byTarget.values()).sort(compareItems);
}

export interface ContinueSectionModel {
  readonly needsInput: readonly ContinueAttentionItem[];
  /** Unread rows on screen. */
  readonly unread: readonly ContinueAttentionItem[];
  /** Every unread row after deduplication, including any past the cap. */
  readonly unreadTotal: number;
  /** Unread rows behind the overflow link; 0 when every row shows. */
  readonly unreadOverflowCount: number;
  readonly lastViewedVisible: boolean;
  readonly interruptedVisible: boolean;
  /** Whether the section renders anything at all. */
  readonly visible: boolean;
}

export interface ContinueSectionModelInput {
  readonly attention: readonly ContinueAttentionItem[];
  readonly lastViewed?: ContinueLastViewed | null;
  readonly interruptedVisible?: boolean;
  /** The visible interrupted row's worktree, when it names one chat. */
  readonly interruptedTarget?: ContinueInterruptedTarget | null;
  /** Whether the host has a destination exposing every unread result. */
  readonly hasUnreadOverflowDestination?: boolean;
}

/**
 * Last viewed is redundant while an attention row already leads to the same
 * worktree. Suppression is display-only: hosts keep the offer itself.
 */
export function isLastViewedSuppressed(
  lastViewed: ContinueLastViewed,
  attention: readonly ContinueAttentionItem[],
): boolean {
  if (lastViewed.worktreeId === undefined) return false;
  return attention.some(
    (item) =>
      item.target.workspaceId === lastViewed.workspaceId &&
      item.target.worktreeId === lastViewed.worktreeId,
  );
}

/**
 * Last viewed is also redundant while the visible interrupted row names a
 * chat in the same worktree; that row opens the chat itself. Both ids must
 * match, since worktree ids are not unique across workspaces.
 */
export function isLastViewedMergedIntoInterrupted(
  lastViewed: ContinueLastViewed,
  interruptedTarget: ContinueInterruptedTarget | null,
  interruptedVisible: boolean,
): boolean {
  return (
    interruptedVisible &&
    interruptedTarget !== null &&
    interruptedTarget.workspaceId.trim().length > 0 &&
    interruptedTarget.worktreeId.trim().length > 0 &&
    lastViewed.worktreeId !== undefined &&
    interruptedTarget.workspaceId === lastViewed.workspaceId &&
    interruptedTarget.worktreeId === lastViewed.worktreeId
  );
}

/** The visibility, order, and capping decisions behind `ContinueSection`. */
export function buildContinueSectionModel({
  attention,
  lastViewed = null,
  interruptedVisible = false,
  interruptedTarget = null,
  hasUnreadOverflowDestination = false,
}: ContinueSectionModelInput): ContinueSectionModel {
  const ranked = rankContinueAttention(attention);
  const needsInput = ranked.filter((item) => item.kind !== 'unread');
  const allUnread = ranked.filter((item) => item.kind === 'unread');
  // Capping is only honest when the rest stay reachable elsewhere.
  const unread =
    hasUnreadOverflowDestination && allUnread.length > CONTINUE_UNREAD_ROW_LIMIT
      ? allUnread.slice(0, CONTINUE_UNREAD_ROW_LIMIT)
      : allUnread;
  const lastViewedVisible =
    lastViewed !== null &&
    !isLastViewedSuppressed(lastViewed, ranked) &&
    !isLastViewedMergedIntoInterrupted(
      lastViewed,
      interruptedTarget,
      interruptedVisible,
    );
  return {
    needsInput,
    unread,
    unreadTotal: allUnread.length,
    unreadOverflowCount: allUnread.length - unread.length,
    lastViewedVisible,
    interruptedVisible,
    visible:
      interruptedVisible ||
      needsInput.length > 0 ||
      allUnread.length > 0 ||
      lastViewedVisible,
  };
}

/** The status phrase after a row's subject. */
export function continueAttentionStatus(item: ContinueAttentionItem): string {
  switch (item.kind) {
    case 'question':
      return 'is waiting for your answer';
    case 'tool-approval':
      return 'is waiting for your approval';
    case 'plan-review':
      return 'has a plan for you to review';
    case 'unread':
      return item.completed === true && item.target.kind === 'chat'
        ? 'finished'
        : 'has unread updates';
  }
}

/** The row's subject: the chat title, or the worktree for a fallback. */
export function continueAttentionSubject(item: ContinueAttentionItem): string {
  return item.target.kind === 'chat' && item.chatTitle
    ? item.chatTitle
    : item.worktreeName;
}

/** Field-wise equality, so host selectors can keep a stable reference. */
export function sameContinueAttentionItems(
  left: readonly ContinueAttentionItem[],
  right: readonly ContinueAttentionItem[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      item.kind === other.kind &&
      continueAttentionTargetKey(item.target) ===
        continueAttentionTargetKey(other.target) &&
      item.workspaceName === other.workspaceName &&
      item.worktreeName === other.worktreeName &&
      item.chatTitle === other.chatTitle &&
      item.eventAt === other.eventAt &&
      item.completed === other.completed
    );
  });
}

/** Counts by kind, for host state reporters. */
export function countContinueAttentionByKind(
  items: readonly ContinueAttentionItem[],
): Record<ContinueAttentionKind, number> {
  const counts: Record<ContinueAttentionKind, number> = {
    question: 0,
    'tool-approval': 0,
    'plan-review': 0,
    unread: 0,
  };
  for (const item of rankContinueAttention(items)) counts[item.kind] += 1;
  return counts;
}
