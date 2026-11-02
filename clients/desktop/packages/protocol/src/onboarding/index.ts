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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept complete ISO date-times, canonicalizing offsets to UTC. */
function normalizeTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const time = Date.parse(value);
  const date = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (
    !Number.isFinite(time) ||
    !Number.isFinite(date) ||
    new Date(date).toISOString().slice(0, 10) !== value.slice(0, 10)
  ) {
    return undefined;
  }
  return new Date(time).toISOString();
}

/** Undefined means corrupt/unsupported, distinct from a never-initialized record. */
export function normalizePlanModeHintRecord(
  value: unknown,
): PlanModeHintRecord | undefined {
  if (
    !isRecord(value) ||
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
  const entries = isRecord(legacyProgress) ? legacyProgress.entries : undefined;
  const entry = isRecord(entries) ? entries['plan-mode'] : undefined;
  if (!isRecord(entry)) return result;
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
