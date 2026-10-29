/**
 * Step numbering for the Getting started checklist, shared by the desktop
 * Home/sidebar cards and the web Getting started host.
 *
 * Done steps are numbered first and remaining steps after, each group in
 * list order, so the live step always reads "done + 1" and finishing steps
 * moves the counter by exactly one. A step that was finished elsewhere
 * (a project that already exists, notifications already on, a dismissal
 * from a previous session) sits behind the user instead of leaving a gap
 * in the numbers ahead. Back and Next walk this same order, so every number
 * is reachable in both directions.
 *
 * Hosts may leave entries out of the count: steps that cannot apply right
 * now (a repository lesson with no repository). Contextual interstitials that
 * only exist in some situations (the connected-tool examples preview, the
 * mobile promo) belong in the host's list once resolved rather than out of
 * the count, so their number is right from first paint. Uncounted entries are
 * not numbered and not navigable; when one is shown anyway it borrows the
 * next remaining step's number so the counter never moves backwards.
 *
 * Lookups are by identity: `stepNumber`, `previous` and `next` must be
 * given the same instances that were passed in `entries`. A copy of an entry
 * is treated as uncounted (it borrows a number and has no neighbours), so
 * hosts that rebuild their lists must look the entry up in the list they
 * passed before asking.
 */
export interface ChecklistProgressInput<T> {
  /** Checklist entries in their curriculum (list) order. */
  entries: readonly T[];
  /** Completed or dismissed, however that happened. */
  isResolved: (entry: T) => boolean;
  /** Whether an entry takes a number and a place in navigation. Default: all. */
  isCounted?: (entry: T) => boolean;
}

export interface ChecklistProgress<T> {
  /** Counted entries in navigation order: done first, then remaining. */
  order: readonly T[];
  /** Number of counted steps, the M in "N/M". */
  total: number;
  /** 1-based number for an entry; an uncounted entry borrows the next remaining number. */
  stepNumber(entry: T): number;
  /** The counted entry before `entry` in `order`, if any. */
  previous(entry: T): T | undefined;
  /** The counted entry after `entry` in `order`, if any. */
  next(entry: T): T | undefined;
}

/** Include project setup for technical roles or when already present or resolved. */
export function retainChecklistProjectStep({
  nontechnical,
  hasProject,
  resolved,
}: {
  nontechnical: boolean;
  hasProject: boolean;
  resolved: boolean;
}): boolean {
  return !nontechnical || hasProject || resolved;
}

/**
 * Whether a project step takes a number. A project that was already there
 * when the checklist started asks nothing of the user and records nothing
 * they did, so it is left out of the count and the navigation: the
 * checklist leads with the first step that asks something of them, and
 * "Connect an AI provider" reads 1 even on a machine with a repository. A
 * project the user adds while the step is live is recorded by the host as
 * the step's completion, so it counts like any other done step and the live
 * step still reads "done + 1".
 */
export function countsProjectStep({
  satisfied,
  recorded,
}: {
  /** A project exists, so the step is complete whether or not the user did it. */
  satisfied: boolean;
  /** The user resolved the step: added a project from it, or skipped it. */
  recorded: boolean;
}): boolean {
  return recorded || !satisfied;
}

export function checklistProgress<T>({
  entries,
  isResolved,
  isCounted = (): boolean => true,
}: ChecklistProgressInput<T>): ChecklistProgress<T> {
  const counted = entries.filter((entry) => isCounted(entry));
  const done = counted.filter((entry) => isResolved(entry));
  const remaining = counted.filter((entry) => !isResolved(entry));
  const order: readonly T[] = [...done, ...remaining];
  const positions = new Map<T, number>(
    order.map((entry, index) => [entry, index]),
  );
  const total = order.length;
  // The number the first remaining step carries; clamped once all are done.
  const borrowed = Math.min(done.length + 1, total);
  return {
    order,
    total,
    stepNumber: (entry): number => {
      const index = positions.get(entry);
      return index === undefined ? borrowed : index + 1;
    },
    previous: (entry): T | undefined => {
      const index = positions.get(entry);
      return index === undefined || index === 0 ? undefined : order[index - 1];
    },
    next: (entry): T | undefined => {
      const index = positions.get(entry);
      return index === undefined ? undefined : order[index + 1];
    },
  };
}
