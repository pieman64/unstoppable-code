/** Host-supplied read state; these formats perform no filesystem operations. */
export type WorkspaceFileRead =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'present'; raw: string };

export type WorkspaceIndexReadAuthority =
  | 'absent'
  | 'unreadable'
  | 'ok'
  | 'partial';

export interface WorkspaceIndexReadEntry<Section extends string> {
  id: string;
  name: string;
  type: 'single-repo' | 'multi-repo' | 'cowork';
  color: string;
  collapsed: boolean;
  order: number;
  pinned?: boolean;
  activitySectionOrder?: Section[];
}

export interface WorkspaceIndexRead<Section extends string> {
  entries: WorkspaceIndexReadEntry<Section>[];
  authority: WorkspaceIndexReadAuthority;
  raw: string | null;
  document: Record<string, unknown> | undefined;
  /** First readable raw entry per id; duplicates still remain in entries. */
  rawEntriesById: Map<string, Record<string, unknown>>;
  unreadableEntries: Record<string, unknown>[];
}

export type WorkspaceManifestRead =
  | { authority: 'absent' }
  | { authority: 'unreadable' }
  | { authority: 'ok'; document: Record<string, unknown> };

/** Only these three fields determine whether the existing format reads a row. */
export interface WorkspaceWorktreeReadRow extends Record<string, unknown> {
  id: string;
  branchName: string;
  createdAt: string;
}

export type WorktreeListRead =
  | { authority: 'absent' }
  | { authority: 'unreadable' }
  | {
      authority: 'ok';
      worktrees: WorkspaceWorktreeReadRow[];
      /** An incomplete list cannot establish selected-id absence. */
      complete: boolean;
      unreadableRowIds: string[];
      document: Record<string, unknown>;
    };

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyIndex<Section extends string>(
  authority: 'absent' | 'unreadable',
): WorkspaceIndexRead<Section> {
  return {
    entries: [],
    authority,
    raw: null,
    document: undefined,
    rawEntriesById: new Map(),
    unreadableEntries: [],
  };
}

function normalizeWorkspaceIndexEntry<Section extends string>(
  entry: Record<string, unknown>,
  normalizeActivitySectionOrder: (value: unknown) => Section[] | undefined,
): WorkspaceIndexReadEntry<Section> | null {
  if (
    typeof entry.id !== 'string' ||
    typeof entry.name !== 'string' ||
    (entry.type !== 'single-repo' &&
      entry.type !== 'multi-repo' &&
      entry.type !== 'cowork') ||
    typeof entry.color !== 'string'
  ) {
    return null;
  }
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    color: entry.color,
    collapsed: typeof entry.collapsed === 'boolean' ? entry.collapsed : false,
    order: typeof entry.order === 'number' ? entry.order : 0,
    ...(entry.pinned === true ? { pinned: true } : {}),
    activitySectionOrder: normalizeActivitySectionOrder(
      entry.activitySectionOrder,
    ),
  };
}

export function readWorkspaceIndex<Section extends string>(
  input: WorkspaceFileRead,
  normalizeActivitySectionOrder: (value: unknown) => Section[] | undefined,
): WorkspaceIndexRead<Section> {
  if (input.state !== 'present') return emptyIndex(input.state);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return emptyIndex('unreadable');
  }
  if (
    !isJsonObject(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.workspaces)
  ) {
    return emptyIndex('unreadable');
  }
  const entries: WorkspaceIndexReadEntry<Section>[] = [];
  const rawEntriesById = new Map<string, Record<string, unknown>>();
  const unreadableEntries: Record<string, unknown>[] = [];
  for (const rawEntry of parsed.workspaces) {
    if (!isJsonObject(rawEntry)) return emptyIndex('unreadable');
    const entry = normalizeWorkspaceIndexEntry(
      rawEntry,
      normalizeActivitySectionOrder,
    );
    if (entry === null) {
      unreadableEntries.push(rawEntry);
      continue;
    }
    entries.push(entry);
    if (!rawEntriesById.has(entry.id)) rawEntriesById.set(entry.id, rawEntry);
  }
  return {
    entries,
    authority: unreadableEntries.length === 0 ? 'ok' : 'partial',
    raw: input.raw,
    document: parsed,
    rawEntriesById,
    unreadableEntries,
  };
}

export function readWorkspaceManifest(
  input: WorkspaceFileRead,
): WorkspaceManifestRead {
  if (input.state !== 'present') return { authority: input.state };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return { authority: 'unreadable' };
  }
  return isJsonObject(parsed) && parsed.version === 1
    ? { authority: 'ok', document: parsed }
    : { authority: 'unreadable' };
}

export function isWorkspaceWorktreeReadRow(
  value: unknown,
): value is WorkspaceWorktreeReadRow {
  return (
    isJsonObject(value) &&
    typeof value.id === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.createdAt === 'string'
  );
}

export function readWorktreeList(input: WorkspaceFileRead): WorktreeListRead {
  if (input.state !== 'present') return { authority: input.state };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return { authority: 'unreadable' };
  }
  if (
    !isJsonObject(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.worktrees)
  ) {
    return { authority: 'unreadable' };
  }
  const worktrees = parsed.worktrees.filter(isWorkspaceWorktreeReadRow);
  const unreadableRowIds = parsed.worktrees.flatMap((row) =>
    !isWorkspaceWorktreeReadRow(row) &&
    isJsonObject(row) &&
    typeof row.id === 'string'
      ? [row.id]
      : [],
  );
  return {
    authority: 'ok',
    worktrees,
    complete: worktrees.length === parsed.worktrees.length,
    unreadableRowIds,
    document: parsed,
  };
}
