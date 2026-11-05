import { isOnboardingObject, normalizeTimestamp } from './shared';

export * from './github-star-prompt';

/** Durable, scope-local lesson state shared by desktop preferences and web storage. */
export interface PlanModeHintRecord {
  /** Initialization/migration marker. Retain it when resetting the lesson. */
  version: 1;
  /**
   * Reset ordering: increment from the last acknowledged record to reset.
   * Writes from older generations are ignored; retirement is monotonic within
   * a generation. Retry a failed write with its original generation.
   */
  generation: number;
  /** Diagnostic only; an impression does not retire the lesson. */
  shownAt?: string;
  dismissedAt?: string;
  triedAt?: string;
}

/** Undefined means corrupt/unsupported, distinct from a never-initialized record. */
export function normalizePlanModeHintRecord(
  value: unknown,
): PlanModeHintRecord | undefined {
  if (
    !isOnboardingObject(value) ||
    value.version !== 1 ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    return undefined;
  }
  const result: PlanModeHintRecord = {
    version: 1,
    generation: value.generation,
  };
  for (const key of ['shownAt', 'dismissedAt', 'triedAt'] as const) {
    const timestamp = normalizeTimestamp(value[key]);
    if (timestamp !== undefined) result[key] = timestamp;
  }
  return result;
}

/**
 * Read the compatibility entry from raw legacy progress, before the active
 * checklist parser removes it. Call only when no hint record has been stored.
 */
export function migrateLegacyPlanModeHintRecord(
  legacyProgress: unknown,
): PlanModeHintRecord {
  const result: PlanModeHintRecord = { version: 1, generation: 0 };
  const entries = isOnboardingObject(legacyProgress)
    ? legacyProgress.entries
    : undefined;
  const entry = isOnboardingObject(entries) ? entries['plan-mode'] : undefined;
  if (!isOnboardingObject(entry)) return result;
  const dismissedAt = normalizeTimestamp(entry.dismissedAt);
  const triedAt = normalizeTimestamp(entry.completedAt);
  if (dismissedAt !== undefined) result.dismissedAt = dismissedAt;
  if (triedAt !== undefined) result.triedAt = triedAt;
  return result;
}

/**
 * Apply inside the persistence owner's serialized read/modify/write operation.
 * A higher generation replaces all history; an older write cannot resurrect it.
 * Within a generation each timestamp advances monotonically, so stale snapshots
 * cannot erase retirement. This pure merge does not coordinate browser writers.
 */
export function mergePlanModeHintRecords(
  current: PlanModeHintRecord,
  incoming: PlanModeHintRecord,
): PlanModeHintRecord {
  if (incoming.generation < current.generation) return { ...current };
  if (incoming.generation > current.generation) return { ...incoming };
  const merged = { ...current };
  for (const key of ['shownAt', 'dismissedAt', 'triedAt'] as const) {
    const timestamp = incoming[key];
    if (
      timestamp !== undefined &&
      (merged[key] === undefined || timestamp > merged[key])
    ) {
      merged[key] = timestamp;
    }
  }
  return merged;
}
