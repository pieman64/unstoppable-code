import type { FileDiffSource } from '@canopy/desktop-shared/types';
import type { DiffSource, DiffViewMode } from '@canopy/ui-shared/components';

const STORAGE_KEY = 'canopy.codeReview.panelWidths.v1';
const DEFAULT_LEFT = 20; // chat %  (center diagram = 100 - left - right = 48%)
const DEFAULT_RIGHT = 32; // diagram %
const MIN_PANEL = 18;
const MAX_SIDE = 45;

export interface CodeReviewPanelWidths {
  leftPercent: number; // chat
  rightPercent: number; // diagram (center = 100 - left - right)
}

export function clampCodeReviewWidths(
  widths: CodeReviewPanelWidths,
): CodeReviewPanelWidths {
  const left = Math.min(MAX_SIDE, Math.max(MIN_PANEL, widths.leftPercent));
  const right = Math.min(MAX_SIDE, Math.max(MIN_PANEL, widths.rightPercent));
  // Ensure center keeps at least MIN_PANEL.
  if (left + right > 100 - MIN_PANEL) {
    const scale = (100 - MIN_PANEL) / (left + right);
    return { leftPercent: left * scale, rightPercent: right * scale };
  }
  return { leftPercent: left, rightPercent: right };
}

export function loadCodeReviewWidths(): CodeReviewPanelWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'leftPercent' in parsed &&
        'rightPercent' in parsed
      ) {
        const record: Record<string, unknown> = parsed;
        const left = record.leftPercent;
        const right = record.rightPercent;
        if (typeof left === 'number' && typeof right === 'number') {
          return clampCodeReviewWidths({
            leftPercent: left,
            rightPercent: right,
          });
        }
      }
    }
  } catch {
    // ignore corrupt state
  }
  return { leftPercent: DEFAULT_LEFT, rightPercent: DEFAULT_RIGHT };
}

export function saveCodeReviewWidths(widths: CodeReviewPanelWidths): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // ignore quota errors
  }
}

const CHAT_COLLAPSED_KEY = 'canopy.codeReview.chatCollapsed.v1';

/** Chat panel collapse state. Defaults to expanded (false). */
export function loadCodeReviewChatCollapsed(): boolean {
  try {
    return localStorage.getItem(CHAT_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveCodeReviewChatCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(CHAT_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // ignore quota errors
  }
}

const DIAGRAM_COLLAPSED_KEY = 'canopy.codeReview.diagramCollapsed.v1';

/** Diagrams panel collapse state. Defaults to expanded (false). */
export function loadCodeReviewDiagramCollapsed(): boolean {
  try {
    return localStorage.getItem(DIAGRAM_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveCodeReviewDiagramCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(DIAGRAM_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // ignore quota errors
  }
}

const TRAY_HEIGHT_KEY = 'canopy.codeReview.commentsTrayHeight.v1';
// Percentage of the code panel's height. Defaults to a compact 24% (~60% of
// the previous 40% cap) so the diff gets more room by default; drag-resizable
// up to the 40% cap and down to a still-usable 12%.
const DEFAULT_TRAY_HEIGHT = 24;
const MIN_TRAY_HEIGHT = 12;
const MAX_TRAY_HEIGHT = 40;

export function clampCodeReviewTrayHeight(value: number): number {
  return Math.min(MAX_TRAY_HEIGHT, Math.max(MIN_TRAY_HEIGHT, value));
}

/** Bottom comments-tray height as a percentage of the code panel. */
export function loadCodeReviewTrayHeight(): number {
  try {
    const raw = localStorage.getItem(TRAY_HEIGHT_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampCodeReviewTrayHeight(parsed);
      }
    }
  } catch {
    // ignore corrupt state
  }
  return DEFAULT_TRAY_HEIGHT;
}

export function saveCodeReviewTrayHeight(value: number): void {
  try {
    localStorage.setItem(
      TRAY_HEIGHT_KEY,
      String(clampCodeReviewTrayHeight(value)),
    );
  } catch {
    // ignore quota errors
  }
}

const COMMENTS_COLLAPSED_KEY = 'canopy.codeReview.commentsCollapsed.v1';

/** Bottom comments-tray collapse state. Defaults to expanded (false). */
export function loadCodeReviewCommentsCollapsed(): boolean {
  try {
    return localStorage.getItem(COMMENTS_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveCodeReviewCommentsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COMMENTS_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // ignore quota errors
  }
}

const FILE_TREE_WIDTH_KEY = 'canopy.codeReview.fileTreeWidth.v1';
// Width of the changed-files tree, in pixels. Defaults to the historical
// 260px; drag-resizable between a still-legible 180px and a generous 560px so
// deeply nested paths get room without the tree swallowing the diff.
const DEFAULT_FILE_TREE_WIDTH = 260;
const MIN_FILE_TREE_WIDTH = 180;
const MAX_FILE_TREE_WIDTH = 560;

export function clampCodeReviewFileTreeWidth(value: number): number {
  return Math.min(MAX_FILE_TREE_WIDTH, Math.max(MIN_FILE_TREE_WIDTH, value));
}

/** File-tree width in pixels. */
export function loadCodeReviewFileTreeWidth(): number {
  try {
    const raw = localStorage.getItem(FILE_TREE_WIDTH_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampCodeReviewFileTreeWidth(parsed);
      }
    }
  } catch {
    // ignore corrupt state
  }
  return DEFAULT_FILE_TREE_WIDTH;
}

export function saveCodeReviewFileTreeWidth(value: number): void {
  try {
    localStorage.setItem(
      FILE_TREE_WIDTH_KEY,
      String(clampCodeReviewFileTreeWidth(value)),
    );
  } catch {
    // ignore quota errors
  }
}

// `DiffViewMode` and `DiffSource` come from `@canopy/ui-shared`. The desktop
// `FileDiffSource` enum is identical at the value level. This module stores
// `DiffSource` (matching the shared diff-selector components); callers that
// live in the `FileDiffSource` world (e.g. `codeReviewStore.ts`) convert at
// the load/save boundary using these exhaustive-switch helpers rather than
// casting (same pattern as `DiffViewerModal.tsx`).
export function toDesktopSource(value: DiffSource): FileDiffSource {
  switch (value) {
    case 'uncommitted':
    case 'committed':
    case 'combined':
      return value;
  }
}

export function toSharedSource(value: FileDiffSource): DiffSource {
  switch (value) {
    case 'uncommitted':
    case 'committed':
    case 'combined':
      return value;
  }
}

const VIEW_PREFS_KEY = 'canopy.codeReview.viewPrefs.v1';

export interface CodeReviewViewPrefs {
  viewMode: DiffViewMode;
  source: DiffSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadCodeReviewViewPrefs(): CodeReviewViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) {
        const record = parsed;
        const viewMode: DiffViewMode =
          record.viewMode === 'split' ? 'split' : 'unified';
        const source: DiffSource =
          record.source === 'uncommitted' || record.source === 'committed'
            ? record.source
            : 'combined';
        return { viewMode, source };
      }
    }
  } catch {
    // ignore corrupt state
  }
  return { viewMode: 'unified', source: 'combined' };
}

export function saveCodeReviewViewPrefs(prefs: CodeReviewViewPrefs): void {
  try {
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota errors
  }
}

/**
 * Normalize a repo id for cross-source lookup keys. `listReviewRepos` emits
 * `repoId: 'default'` for single-repo projects while `ChangedFileInfo.repoId`
 * is `undefined` there — both must resolve to the same lookup key so review
 * comment threads/annotations (keyed off the review's repoId) match changed
 * files (keyed off the activity panel's repoId). Use this for every
 * annotation/thread/file lookup key in the code-review components.
 */
export function normalizeRepoKey(repoId: string | undefined): string {
  return repoId === undefined || repoId === 'default' ? '' : repoId;
}
