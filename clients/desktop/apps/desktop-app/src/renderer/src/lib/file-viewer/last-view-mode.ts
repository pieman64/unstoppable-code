import type { FileTabViewMode } from '@canopy/desktop-shared/types';
import {
  isRichDocumentRenderKind,
  resolveFileRenderKind,
} from '@canopy/ui-app/file-kind';
import { initialFileTabViewMode } from './initial-view-mode';

/**
 * Renderer-session memory of the last Source/Formatted/Table choice per file,
 * so reopening a closed file tab from any entry point restores that choice.
 *
 * Lifetime: module scope. Closing a tab keeps the entry; a renderer restart
 * drops every entry. Open tabs keep their own persisted mode, so this only
 * decides how a *new* tab starts. `diff` is never remembered: it needs a
 * comparison context and is not a reading preference.
 */

/** The canonical identity of a file within one worktree. */
export interface FileViewModeIdentity {
  readonly projectId: string | undefined;
  readonly worktreeId: string | undefined;
  readonly absolutePath: string | undefined;
}

type RememberedFileViewMode = Exclude<FileTabViewMode, 'diff'>;

interface RememberedEntry {
  readonly mode: RememberedFileViewMode;
  readonly sequence: number;
  /** The tab whose user choice set this entry; absent for close snapshots. */
  readonly chosenInTabId?: string;
  /** A snapshot can precede acknowledgement of an earlier choice. */
  readonly snapshotInTabId?: string;
}

/**
 * When the observation happened and which tab it came from. Capture
 * `sequence` when the choice is observed (a click, or the start of a close) so
 * a slow close cannot overwrite a choice the user made after it.
 */
export interface FileViewModeObservation {
  readonly sequence: number;
  readonly tabId: string;
}

const rememberedModes = new Map<string, RememberedEntry>();
let lastSequence = 0;

function memoryKey(identity: FileViewModeIdentity): string | null {
  const { projectId, worktreeId, absolutePath } = identity;
  // A missing part must never collapse distinct files onto one shared key.
  if (!projectId || !worktreeId || !absolutePath) return null;
  return JSON.stringify([projectId, worktreeId, absolutePath]);
}

/** A monotonically increasing observation stamp. */
export function nextFileViewModeSequence(): number {
  lastSequence += 1;
  return lastSequence;
}

function remember(
  identity: FileViewModeIdentity,
  mode: FileTabViewMode | undefined,
  observation: FileViewModeObservation,
  origin: 'choice' | 'snapshot',
): void {
  // Absent modes and `diff` never erase an earlier choice.
  if (mode === undefined || mode === 'diff') return;
  const key = memoryKey(identity);
  if (key === null) return;
  const existing = rememberedModes.get(key);
  if (
    existing &&
    existing.sequence > observation.sequence &&
    !(origin === 'choice' && existing.snapshotInTabId === observation.tabId)
  ) {
    return;
  }
  // A choice applied in this tab is authoritative over its reading snapshot,
  // which may predate the choice's committed delta.
  if (origin === 'snapshot' && existing?.chosenInTabId === observation.tabId) {
    return;
  }
  rememberedModes.set(key, {
    mode,
    sequence: observation.sequence,
    ...(origin === 'choice'
      ? { chosenInTabId: observation.tabId }
      : { snapshotInTabId: observation.tabId }),
  });
}

/** Remember a view mode the user successfully applied in an open tab. */
export function rememberFileViewModeChoice(
  identity: FileViewModeIdentity,
  mode: FileTabViewMode,
  observation: FileViewModeObservation,
): void {
  remember(identity, mode, observation, 'choice');
}

/**
 * Remember the mode a file tab held when its close succeeded, covering tabs
 * initialized or restored without a toggle.
 */
export function rememberClosedFileViewMode(
  identity: FileViewModeIdentity,
  mode: FileTabViewMode | undefined,
  observation: FileViewModeObservation,
): void {
  remember(identity, mode, observation, 'snapshot');
}

/**
 * Preserve an initialized/restored reading mode when Diff is accepted. A
 * committed choice from this tab wins over this potentially older snapshot.
 */
export function rememberFileViewModeBeforeDiff(
  identity: FileViewModeIdentity,
  mode: FileTabViewMode | undefined,
  observation: FileViewModeObservation,
): void {
  remember(identity, mode, observation, 'snapshot');
}

function basename(path: string): string {
  return path.slice(
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1,
  );
}

function isModeValidForFile(
  mode: RememberedFileViewMode,
  absolutePath: string,
): boolean {
  if (mode === 'raw') {
    const kind = resolveFileRenderKind({ path: basename(absolutePath) });
    return kind !== 'image' && !isRichDocumentRenderKind(kind);
  }
  return initialFileTabViewMode(absolutePath) === mode;
}

/** The remembered mode for the file, or `undefined` if none fits its kind. */
export function readRememberedFileViewMode(
  identity: FileViewModeIdentity,
): RememberedFileViewMode | undefined {
  const key = memoryKey(identity);
  if (key === null || !identity.absolutePath) return undefined;
  const entry = rememberedModes.get(key);
  if (!entry) return undefined;
  return isModeValidForFile(entry.mode, identity.absolutePath)
    ? entry.mode
    : undefined;
}

/**
 * The mode a new or newly assigned file tab starts in: an explicit caller mode,
 * then the remembered compatible choice, then the file kind's default.
 * `undefined` keeps the host's raw fallback.
 */
export function resolveNewFileTabViewMode(
  identity: FileViewModeIdentity,
  explicitMode?: FileTabViewMode,
): FileTabViewMode | undefined {
  if (explicitMode) return explicitMode;
  return (
    readRememberedFileViewMode(identity) ??
    (identity.absolutePath
      ? initialFileTabViewMode(identity.absolutePath)
      : undefined)
  );
}

/** Test-only: forget every remembered choice. */
export function resetFileViewModeMemoryForTests(): void {
  rememberedModes.clear();
  lastSequence = 0;
}
