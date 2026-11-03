import type { ExternalProjectCandidate } from '@canopy/desktop-shared/types';

/**
 * Selection and summary rules for folders the user picked and the
 * repositories discovered inside them (CAN-5487). Shared by the first-run
 * page and the Settings import panel so both apply one policy.
 *
 * A picked plain folder and a repository found inside it cannot both be
 * imported: selecting one removes the other. Relationships come from every
 * `parentCandidateIds` entry, not only the parent a row is grouped under.
 */

export const PLAIN_FOLDER_DETAIL = 'Plain folder';
export const CODE_REPOSITORY_DETAIL = 'Code repository';
export const INCOMPLETE_SCAN_NOTE =
  'Could not finish checking for repositories';
export const CAPPED_SCAN_NOTE =
  'Choose a repository folder directly to import one that is not listed';

/** The user chose this folder in the folder picker. */
export function isDirectPick(candidate: ExternalProjectCandidate): boolean {
  return candidate.surfaces.includes('custom-folder');
}

/** Picked directly, or discovered inside a picked folder. */
export function isPickerCandidate(
  candidate: ExternalProjectCandidate,
): boolean {
  return (
    isDirectPick(candidate) ||
    candidate.surfaces.includes('nested-repository') ||
    // Independently discovered provider rows beyond the nested listing cap
    // still carry exact discovery relationships and appear in its summary.
    (candidate.parentCandidateIds?.length ?? 0) > 0
  );
}

/** A picked plain folder holding at least one confirmed repository. */
export function isRepositoryParent(
  candidate: ExternalProjectCandidate,
): boolean {
  return (
    candidate.kind === 'folder' &&
    (candidate.nestedRepositories?.count ?? 0) > 0
  );
}

/**
 * A picked plain folder whose scan did not finish or reported nothing; its
 * count is a lower bound at best, so it never defaults to selected.
 */
export function isUncertainPickedFolder(
  candidate: ExternalProjectCandidate,
): boolean {
  return (
    isDirectPick(candidate) &&
    candidate.kind === 'folder' &&
    candidate.nestedRepositories?.complete !== true
  );
}

/** Whether defaults and `Select all` may include the candidate. */
export function isBulkSelectable(candidate: ExternalProjectCandidate): boolean {
  return !isRepositoryParent(candidate) && !isUncertainPickedFolder(candidate);
}

function trimSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function isPathInside(child: string, parent: string): boolean {
  const base = trimSeparators(parent);
  return (
    child.length > base.length + 1 &&
    child.startsWith(base) &&
    /[\\/]/.test(child.charAt(base.length))
  );
}

/** Candidates that cannot be imported together with `candidate`. */
function conflictsWith(
  candidate: ExternalProjectCandidate,
  other: ExternalProjectCandidate,
): boolean {
  if (candidate.id === other.id) return false;
  if (candidate.parentCandidateIds?.includes(other.id)) return true;
  if (other.parentCandidateIds?.includes(candidate.id)) return true;
  // A direct repository pick can be below the supported scan depth, or come
  // from an older host without relationships. Match import's containment rule.
  if (isDirectPick(candidate) || isDirectPick(other))
    return (
      isPathInside(candidate.rootPath, other.rootPath) ||
      isPathInside(other.rootPath, candidate.rootPath)
    );
  return false;
}

/** Ids of the listed candidates that cannot be selected with `id`. */
export function conflictingIds(
  id: string,
  candidates: readonly ExternalProjectCandidate[],
): string[] {
  const candidate = candidates.find((entry) => entry.id === id);
  if (!candidate) return [];
  return candidates
    .filter((other) => conflictsWith(candidate, other))
    .map((other) => other.id);
}

/** Adds `id` and drops every selection that conflicts with it. */
export function selectExclusive(
  current: ReadonlySet<string>,
  id: string,
  candidates: readonly ExternalProjectCandidate[],
): Set<string> {
  const next = new Set(current);
  for (const conflict of conflictingIds(id, candidates)) next.delete(conflict);
  next.add(id);
  return next;
}

/**
 * Keeps the selected ids that are still `eligible` in `candidates` and free
 * of conflicts. Repositories win over the folders that hold them; overlapping
 * folders keep the outermost.
 */
export function reconcileSelection(
  selected: Iterable<string>,
  candidates: readonly ExternalProjectCandidate[],
  eligible: (candidate: ExternalProjectCandidate) => boolean,
): Set<string> {
  const wanted = new Set(selected);
  const ordered = candidates
    .filter((candidate) => wanted.has(candidate.id) && eligible(candidate))
    .sort(
      (a, b) =>
        Number(isRepositoryParent(a)) - Number(isRepositoryParent(b)) ||
        a.rootPath.length - b.rootPath.length ||
        a.rootPath.localeCompare(b.rootPath),
    );
  const kept: ExternalProjectCandidate[] = [];
  for (const candidate of ordered) {
    if (kept.some((other) => conflictsWith(candidate, other))) continue;
    kept.push(candidate);
  }
  return new Set(kept.map((candidate) => candidate.id));
}

/** A submission must preserve the entire choice, never silently import a subset. */
export function isCurrentSelection(
  selected: ReadonlySet<string>,
  candidates: readonly ExternalProjectCandidate[],
  eligible: (candidate: ExternalProjectCandidate) => boolean,
): boolean {
  return (
    selected.size > 0 &&
    reconcileSelection(selected, candidates, eligible).size === selected.size
  );
}

/** The conflict-free set `Select all` turns on among `eligible` rows. */
export function bulkSelection(
  eligible: readonly ExternalProjectCandidate[],
): Set<string> {
  return reconcileSelection(
    eligible.map((candidate) => candidate.id),
    eligible,
    isBulkSelectable,
  );
}

/**
 * Turns on the bulk set and drops current selections that conflict with it,
 * such as a picked parent of a repository being added.
 */
export function selectAllExclusive(
  current: ReadonlySet<string>,
  bulk: ReadonlySet<string>,
  candidates: readonly ExternalProjectCandidate[],
): Set<string> {
  const next = new Set(bulk);
  const added = candidates.filter((candidate) => bulk.has(candidate.id));
  for (const id of current) {
    if (next.has(id)) continue;
    const candidate = candidates.find((entry) => entry.id === id);
    if (candidate && added.some((other) => conflictsWith(candidate, other)))
      continue;
    next.add(id);
  }
  return next;
}

export interface PickedSummaryLine {
  readonly key: string;
  readonly lead: string;
  /** A folder name, rendered with the replay mask. */
  readonly name: string | null;
  readonly tail: string;
}

export interface PickedSummary {
  readonly lines: PickedSummaryLine[];
  readonly notes: string[];
}

function repositoriesWord(count: number): string {
  return count === 1 ? 'repository' : 'repositories';
}

function foldersWord(count: number): string {
  return count === 1 ? 'folder' : 'folders';
}

function omittedNote(omitted: readonly ExternalProjectCandidate[]): string {
  const added = omitted.filter(
    (candidate) =>
      candidate.status === 'already-tracked' ||
      candidate.status === 'already-imported',
  ).length;
  const other = omitted.length - added;
  return [
    ...(added > 0 ? [`${added} already added`] : []),
    ...(other > 0 ? [`${other} unavailable`] : []),
  ].join(' · ');
}

/**
 * What the picks in `candidates` found, from every picked folder before
 * availability filtering: one line per folder holding repositories, then the
 * remaining direct picks. `shown` holds the ids the surface renders. Returns
 * `null` when nothing was picked.
 */
export function pickedSummary(
  candidates: readonly ExternalProjectCandidate[],
  shown: ReadonlySet<string>,
): PickedSummary | null {
  const picks = candidates
    .filter(isDirectPick)
    .sort((a, b) => a.rootPath.localeCompare(b.rootPath));
  if (picks.length === 0) return null;
  const lines: PickedSummaryLine[] = [];
  let incomplete = false;
  let capped = false;
  let plainPicks = 0;
  for (const pick of picks) {
    const scan = pick.nestedRepositories;
    if (!isRepositoryParent(pick) || !scan) {
      plainPicks += 1;
      if (isUncertainPickedFolder(pick)) incomplete = true;
      continue;
    }
    const related = candidates.filter((candidate) =>
      candidate.parentCandidateIds?.includes(pick.id),
    );
    const displayed = related.filter((candidate) => shown.has(candidate.id));
    const omitted = related.filter((candidate) => !shown.has(candidate.id));
    const orMore = scan.complete ? '' : ' or more';
    if (!scan.complete) incomplete = true;
    const lead =
      related.length < scan.count
        ? `Showing ${displayed.length} of ${scan.count}${orMore} ${repositoriesWord(scan.count)} in `
        : `Found ${scan.count}${orMore} ${repositoriesWord(scan.count)} in `;
    if (related.length < scan.count) capped = true;
    const availability = omitted.length > 0 ? omittedNote(omitted) : '';
    lines.push({
      key: pick.id,
      lead,
      name: pick.displayName,
      tail: availability ? ` · ${availability}` : '',
    });
  }
  if (plainPicks > 0) {
    lines.push({
      key: 'direct-picks',
      lead: `${lines.length > 0 ? 'You also chose' : 'You chose'} ${plainPicks} ${foldersWord(plainPicks)}`,
      name: null,
      tail: '',
    });
  }
  const notes = [
    ...(incomplete ? [INCOMPLETE_SCAN_NOTE] : []),
    ...(capped ? [CAPPED_SCAN_NOTE] : []),
  ];
  return { lines, notes };
}

/** `Contains 3 code repositories`, for a picked folder's row in Settings. */
export function containedRepositoriesLabel(
  candidate: ExternalProjectCandidate,
): string | null {
  const scan = candidate.nestedRepositories;
  if (!scan || scan.count === 0) return null;
  const word = scan.count === 1 ? 'code repository' : 'code repositories';
  return `Contains ${scan.count}${scan.complete ? '' : ' or more'} ${word}`;
}

/**
 * Whether a picked folder lists fewer repositories than it holds, counting
 * related rows in every status.
 */
export function isCappedParent(
  candidate: ExternalProjectCandidate,
  candidates: readonly ExternalProjectCandidate[],
): boolean {
  const count = candidate.nestedRepositories?.count ?? 0;
  if (count === 0) return false;
  const related = candidates.filter((entry) =>
    entry.parentCandidateIds?.includes(candidate.id),
  ).length;
  return related < count;
}

/**
 * First-run row order: each picked folder's repositories A–Z, then the folder
 * itself, grouped by folder path; then every other row by recent activity.
 * A repository under several picked folders shows once, under the first by
 * path; one whose folders are all absent shows among the other rows.
 */
export function orderPickedGroups(
  rows: readonly ExternalProjectCandidate[],
  compareRest: (
    a: ExternalProjectCandidate,
    b: ExternalProjectCandidate,
  ) => number,
): ExternalProjectCandidate[] {
  const parents = rows
    .filter(isRepositoryParent)
    .sort((a, b) => a.rootPath.localeCompare(b.rootPath));
  const parentIds = new Set(parents.map((parent) => parent.id));
  // Parents are sorted by path, so the first match is the stable group.
  const groupOf = (row: ExternalProjectCandidate): string | null =>
    parents.find((parent) => row.parentCandidateIds?.includes(parent.id))?.id ??
    null;
  const children = new Map<string, ExternalProjectCandidate[]>();
  const rest: ExternalProjectCandidate[] = [];
  for (const row of rows) {
    if (parentIds.has(row.id)) continue;
    const group = groupOf(row);
    if (group === null) {
      rest.push(row);
      continue;
    }
    const members = children.get(group) ?? [];
    members.push(row);
    children.set(group, members);
  }
  const grouped = parents.flatMap((parent) => [
    ...(children.get(parent.id) ?? []).sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) ||
        a.rootPath.localeCompare(b.rootPath),
    ),
    parent,
  ]);
  return [...grouped, ...rest.sort(compareRest)];
}
