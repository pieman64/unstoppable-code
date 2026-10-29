/**
 * Generic helpers for grouping repo-scoped entries (hooks/scripts) into rows
 * for display in the Activity panel sections. Both {@link HooksSection} and
 * {@link ScriptsSection} previously hand-rolled near-identical group-by-repo
 * passes; this module factors the shared structure so each section can keep
 * its section-specific predicates (e.g. workspace lifecycle grouping) on top.
 */
export interface RepoGroupedEntry<TEntry> {
  repoId: string;
  repoName: string;
  entries: TEntry[];
}

export type GroupedEntryRow<TEntry> =
  | { kind: 'entry'; entry: TEntry }
  | { kind: 'repo-group'; group: RepoGroupedEntry<TEntry> };

interface BuildRepoGroupedRowsOptions<TEntry> {
  /** Source entries in display order. First-seen order is preserved. */
  entries: readonly TEntry[];
  /** Predicate marking an entry as repo-scoped (eligible for grouping). */
  isRepoScoped: (entry: TEntry) => boolean;
  /** Repo id key used to coalesce entries into a single repo group. */
  getRepoId: (entry: TEntry) => string | undefined;
  /** Display name for the repo group header. Falls back to repo id. */
  getRepoName: (entry: TEntry) => string | undefined;
}

/**
 * Group repo-scoped entries into `repo-group` rows while preserving non-repo
 * entries as plain `entry` rows. Single-entry repo groups are flattened back
 * to plain entries to avoid an unnecessary expand/collapse chrome — this
 * matches the legacy hand-rolled behavior of both sections.
 */
export function buildRepoGroupedRows<TEntry>({
  entries,
  isRepoScoped,
  getRepoId,
  getRepoName,
}: BuildRepoGroupedRowsOptions<TEntry>): GroupedEntryRow<TEntry>[] {
  const rows: GroupedEntryRow<TEntry>[] = [];
  const repoGroups = new Map<string, RepoGroupedEntry<TEntry>>();

  for (const entry of entries) {
    if (!isRepoScoped(entry)) {
      rows.push({ kind: 'entry', entry });
      continue;
    }

    const repoId = getRepoId(entry);
    if (!repoId) {
      rows.push({ kind: 'entry', entry });
      continue;
    }

    const existing = repoGroups.get(repoId);
    if (existing) {
      existing.entries.push(entry);
    } else {
      const group: RepoGroupedEntry<TEntry> = {
        repoId,
        repoName: getRepoName(entry) ?? repoId,
        entries: [entry],
      };
      repoGroups.set(repoId, group);
      rows.push({ kind: 'repo-group', group });
    }
  }

  return rows.map((row) => {
    if (row.kind === 'repo-group' && row.group.entries.length === 1) {
      return { kind: 'entry', entry: row.group.entries[0] };
    }
    return row;
  });
}

/**
 * Toggle a string in an immutable `Set`. Returns a new Set with the value
 * added if previously absent, or removed if previously present.
 *
 * Used by the activity panel to flip per-repo and per-lifecycle expand state
 * inside `setExpandedRepos`/`setExpandedWorkspaceLifecycles` without mutating
 * the previous set.
 */
export function toggleStringInSet<TValue extends string>(
  previous: Set<TValue>,
  value: TValue,
): Set<TValue> {
  const next = new Set(previous);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}
