export interface GroupRun<T> {
  key: string;
  /** Zero-based occurrence of this key, unique with `key` across runs. */
  occurrence: number;
  rows: T[];
}

/**
 * Splits rows into contiguous same-group runs without reordering them, so a
 * ranked list can show a heading per run instead of regrouping its rows.
 */
export function groupContiguousRuns<T>(
  rows: readonly T[],
  groupKey: (row: T) => string,
): GroupRun<T>[] {
  const runs: GroupRun<T>[] = [];
  const occurrences = new Map<string, number>();
  for (const row of rows) {
    const key = groupKey(row);
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      continue;
    }
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    runs.push({ key, occurrence, rows: [row] });
  }
  return runs;
}
