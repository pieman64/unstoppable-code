/*
 * Threads for a Ledger list: each entry with the corrections that correct it,
 * the way a post gathers its replies. Pure, so the scope panel and the Feed
 * group the same way.
 */

/** What grouping reads from an entry. */
export interface LedgerThreadMember {
  readonly entryId: string;
  /** The entry this one corrects, when it is a correction. */
  readonly supersedesEntryId?: string;
  readonly createdAt: string;
}

/** One entry and the loaded corrections that correct it, at any depth. */
export interface LedgerThread<Entry extends LedgerThreadMember> {
  /** The entry the thread is about; for an orphan, the correction itself. */
  readonly root: Entry;
  /**
   * Corrections of the root and of each other, oldest first. Each keeps its
   * own `supersedesEntryId`, so a reply to a reply reads as one.
   */
  readonly corrections: readonly Entry[];
  /** The root is a correction whose target is not loaded. */
  readonly orphan: boolean;
}

/** The entry a member corrects, ignoring a reference to itself. */
function targetOf(entry: LedgerThreadMember): string | undefined {
  const target = entry.supersedesEntryId;
  return target === undefined || target === entry.entryId ? undefined : target;
}

function createdTime(entry: LedgerThreadMember): number {
  return Date.parse(entry.createdAt);
}

/**
 * Groups loaded entries into threads, in display order. A correction whose
 * target is loaded joins the target's thread, and chains flatten: a
 * correction of a correction joins the original's thread. Naturally, a
 * thread sits where its first member sits in `entries` (lists are newest
 * first, so that is its most recent member), and appending a next page never
 * moves a thread already placed.
 *
 * `previousOrder`, the root IDs a list last showed, keeps those threads in
 * that order while the list's entries change in place, so a new correction
 * never moves its thread. A thread the list did not show goes right after
 * the nearest shown thread that naturally comes before it, or first when
 * none does: a new entry, being the newest, goes to the top. A thread counts
 * as shown when any member's ID is in the order, so an orphan keeps its
 * place once its target loads and roots its thread.
 *
 * A correction whose target is not loaded is an orphan thread of its own.
 * Entry IDs are unique: a repeated ID keeps its first occurrence. A
 * self-reference is ignored, and a cycle roots at its member that comes
 * first.
 */
export function groupLedgerThreads<Entry extends LedgerThreadMember>(
  entries: readonly Entry[],
  previousOrder?: readonly string[],
): LedgerThread<Entry>[] {
  const indexById = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (!indexById.has(entry.entryId)) indexById.set(entry.entryId, index);
  });

  const rootOf = new Map<number, number>();
  const resolveRoot = (start: number): number => {
    const path: number[] = [];
    let current = start;
    let root: number;
    for (;;) {
      const known = rootOf.get(current);
      if (known !== undefined) {
        root = known;
        break;
      }
      const seenAt = path.indexOf(current);
      if (seenAt !== -1) {
        root = Math.min(...path.slice(seenAt));
        break;
      }
      path.push(current);
      const entry = entries[current];
      const target = entry === undefined ? undefined : targetOf(entry);
      const targetIndex =
        target === undefined ? undefined : indexById.get(target);
      if (targetIndex === undefined) {
        root = current;
        break;
      }
      current = targetIndex;
    }
    for (const member of path) rootOf.set(member, root);
    return root;
  };

  const byRoot = new Map<number, number[]>();
  const order: number[] = [];
  entries.forEach((entry, index) => {
    if (indexById.get(entry.entryId) !== index) return;
    const root = resolveRoot(index);
    let members = byRoot.get(root);
    if (members === undefined) {
      members = [];
      byRoot.set(root, members);
      order.push(root);
    }
    if (index !== root) members.push(index);
  });

  const naturalThreads = order.flatMap((rootIndex): LedgerThread<Entry>[] => {
    const root = entries[rootIndex];
    if (root === undefined) return [];
    const target = targetOf(root);
    const corrections = [...(byRoot.get(rootIndex) ?? [])]
      .sort((left, right) => {
        const leftEntry = entries[left];
        const rightEntry = entries[right];
        const leftTime =
          leftEntry === undefined ? Number.NaN : createdTime(leftEntry);
        const rightTime =
          rightEntry === undefined ? Number.NaN : createdTime(rightEntry);
        if (
          Number.isFinite(leftTime) &&
          Number.isFinite(rightTime) &&
          leftTime !== rightTime
        ) {
          return leftTime - rightTime;
        }
        // Lists are newest first: later in the list is older.
        return right - left;
      })
      .flatMap((index) => {
        const entry = entries[index];
        return entry === undefined ? [] : [entry];
      });
    return [
      {
        root,
        corrections,
        orphan: target !== undefined && !indexById.has(target),
      },
    ];
  });

  if (previousOrder === undefined || naturalThreads.length < 2) {
    return naturalThreads;
  }

  const previousIndexById = new Map<string, number>();
  previousOrder.forEach((entryId, index) => {
    if (!previousIndexById.has(entryId)) previousIndexById.set(entryId, index);
  });

  type AnchoredThread = {
    readonly thread: LedgerThread<Entry>;
    readonly naturalIndex: number;
    readonly anchorIndex: number;
  };
  const previouslyPlaced: AnchoredThread[] = [];
  const placedByNaturalIndex = new Map<number, AnchoredThread>();
  naturalThreads.forEach((thread, naturalIndex) => {
    let anchorIndex = previousIndexById.get(thread.root.entryId);
    for (const correction of thread.corrections) {
      const correctionIndex = previousIndexById.get(correction.entryId);
      if (
        correctionIndex !== undefined &&
        (anchorIndex === undefined || correctionIndex < anchorIndex)
      ) {
        anchorIndex = correctionIndex;
      }
    }
    if (anchorIndex === undefined) return;
    const anchored = { thread, naturalIndex, anchorIndex };
    previouslyPlaced.push(anchored);
    placedByNaturalIndex.set(naturalIndex, anchored);
  });

  if (previouslyPlaced.length === 0) return naturalThreads;
  previouslyPlaced.sort((left, right) => left.anchorIndex - right.anchorIndex);

  // A thread the list did not show follows the nearest shown thread before
  // it in natural order; with none before it, it leads the list.
  const leading: LedgerThread<Entry>[] = [];
  const following = new Map<number, LedgerThread<Entry>[]>();
  let lastPlacedIndex: number | undefined;
  naturalThreads.forEach((thread, naturalIndex) => {
    if (placedByNaturalIndex.has(naturalIndex)) {
      lastPlacedIndex = naturalIndex;
      return;
    }
    if (lastPlacedIndex === undefined) {
      leading.push(thread);
      return;
    }
    const after = following.get(lastPlacedIndex) ?? [];
    after.push(thread);
    following.set(lastPlacedIndex, after);
  });

  const displayed: LedgerThread<Entry>[] = [...leading];
  for (const anchored of previouslyPlaced) {
    displayed.push(anchored.thread);
    displayed.push(...(following.get(anchored.naturalIndex) ?? []));
  }
  return displayed;
}
