import type {
  FileIndexingCustomGlob,
  FileIndexingPreferences,
  FileLabelBucket,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  BUILTIN_INDEX_GLOBS,
  BUILTIN_INDEX_GLOB_IDS,
  type BuiltinIndexGlob,
} from '@canopy/desktop-shared/file-indexing';
import { mergeFileLabelsWithBuiltins } from '@canopy/desktop-shared/file-labels';

/**
 * Subset of {@link PreferencesLoadResult} the Files settings tab needs to
 * read. Keeping it structural lets the loader return whatever the IPC layer
 * provides without us having to keep a parallel type definition in sync.
 */
type FilesTabPreferencesSnapshot = Pick<
  PreferencesData,
  'fileAutoSave' | 'fileIndexing'
> &
  Partial<Pick<PreferencesData, 'fileLabels'>>;

/**
 * Source-of-truth API the tab depends on. Real callers pass the full
 * `window.api`; tests pass a minimal stub.
 */
export interface FilesTabPreferencesApi {
  loadPreferences: () => Promise<FilesTabPreferencesSnapshot>;
  savePreferences?: (
    update: Partial<PreferencesData>,
  ) => Promise<PreferencesData>;
}

export interface FilesTabBuiltinRow {
  id: string;
  label: string;
  pattern: string;
  enabled: boolean;
}

/**
 * Renderer-side row shape for a user-defined custom glob. Currently a 1:1
 * alias for {@link FileIndexingCustomGlob}; defined as its own type so the
 * tab's UI surface can diverge later (e.g. add a per-row dirty/error flag)
 * without touching every call site.
 */
export type FilesTabCustomRow = FileIndexingCustomGlob;

export interface FilesTabLoadingState {
  status: 'loading';
}

export interface FilesTabErrorState {
  status: 'error';
}

export interface FilesTabReadyState {
  status: 'ready';
  autoSaveEnabled: boolean;
  fileIndexing: FileIndexingPreferences;
  builtinRows: FilesTabBuiltinRow[];
  customRows: FilesTabCustomRow[];
  /** State for the "Do not index" save round-trip. */
  saveStatus: 'idle' | 'saving' | 'error';
  /** Merged (seeded + persisted) file-label buckets in priority order. */
  fileLabels: FileLabelBucket[];
  /** State for the "Labels" save round-trip. */
  labelsSaveStatus: 'idle' | 'saving' | 'error';
}

export type FilesTabState =
  | FilesTabLoadingState
  | FilesTabErrorState
  | FilesTabReadyState;

/**
 * Compute the rendered built-in rows from {@link BUILTIN_INDEX_GLOBS} plus
 * the user's `disabledBuiltinGlobIds`. The shared `BUILTIN_INDEX_GLOBS`
 * provides the canonical id/label/pattern triples.
 */
export function getBuiltinRows(
  fileIndexing: FileIndexingPreferences,
): FilesTabBuiltinRow[] {
  const disabled = new Set(fileIndexing.disabledBuiltinGlobIds);
  return BUILTIN_INDEX_GLOBS.map((g: BuiltinIndexGlob) => ({
    id: g.id,
    label: g.label,
    pattern: g.pattern,
    enabled: !disabled.has(g.id),
  }));
}

export function getCustomRows(
  fileIndexing: FileIndexingPreferences,
): FilesTabCustomRow[] {
  return fileIndexing.customGlobs.map((g) => ({ ...g }));
}

/**
 * Validation for an in-progress add of a new custom glob. Mirrors the error
 * strings the FilesTab UI renders.
 */
export function validateNewCustomGlob(
  pattern: string,
  existingPatterns: ReadonlyArray<string>,
): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return 'Enter a glob pattern.';
  }
  if (existingPatterns.includes(trimmed)) {
    return 'This glob is already listed.';
  }
  return null;
}

/**
 * Snapshot loader. Returns either an error state or the ready state derived
 * from `loadPreferences`.
 */
export async function loadFilesTabState(
  api: FilesTabPreferencesApi,
): Promise<FilesTabErrorState | FilesTabReadyState> {
  try {
    const prefs = await api.loadPreferences();
    const fileIndexing = normalizeFileIndexing(prefs.fileIndexing);
    return {
      status: 'ready',
      autoSaveEnabled: !!prefs.fileAutoSave,
      fileIndexing,
      builtinRows: getBuiltinRows(fileIndexing),
      customRows: getCustomRows(fileIndexing),
      saveStatus: 'idle',
      fileLabels: mergeFileLabelsWithBuiltins(prefs.fileLabels ?? []),
      labelsSaveStatus: 'idle',
    };
  } catch {
    return { status: 'error' };
  }
}

/**
 * Defensive normalization for the renderer side — drops unknown built-in
 * ids and skips empty custom globs even if a downgraded backend somehow
 * returns invalid data. The backend already normalizes, so this is a
 * belt-and-suspenders pass.
 */
function normalizeFileIndexing(
  value: FileIndexingPreferences | undefined,
): FileIndexingPreferences {
  if (!value) {
    return { disabledBuiltinGlobIds: [], customGlobs: [] };
  }
  const seenDisabled = new Set<string>();
  const disabledBuiltinGlobIds: string[] = [];
  for (const id of value.disabledBuiltinGlobIds ?? []) {
    if (!BUILTIN_INDEX_GLOB_IDS.has(id)) continue;
    if (seenDisabled.has(id)) continue;
    seenDisabled.add(id);
    disabledBuiltinGlobIds.push(id);
  }
  const seenPatterns = new Set<string>();
  const customGlobs: FileIndexingCustomGlob[] = [];
  for (const entry of value.customGlobs ?? []) {
    const trimmed = entry.pattern?.trim();
    if (!trimmed) continue;
    if (seenPatterns.has(trimmed)) continue;
    seenPatterns.add(trimmed);
    customGlobs.push({
      id: entry.id,
      pattern: trimmed,
      enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
    });
  }
  return { disabledBuiltinGlobIds, customGlobs };
}
