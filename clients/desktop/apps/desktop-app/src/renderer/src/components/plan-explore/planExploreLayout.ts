const TRAY_HEIGHT_KEY = 'canopy.planExplore.commentsTrayHeight.v1';
// Percentage of the plan document panel's height. Mirrors
// `codeReviewLayout.ts`'s `DEFAULT_TRAY_HEIGHT`/`MIN_TRAY_HEIGHT`/
// `MAX_TRAY_HEIGHT` so the two trays feel identical out of the box.
const DEFAULT_TRAY_HEIGHT = 24;
const MIN_TRAY_HEIGHT = 12;
const MAX_TRAY_HEIGHT = 40;

export function clampPlanExploreTrayHeight(value: number): number {
  return Math.min(MAX_TRAY_HEIGHT, Math.max(MIN_TRAY_HEIGHT, value));
}

/** Bottom comments-tray height as a percentage of the plan document panel. */
export function loadPlanExploreTrayHeight(): number {
  try {
    const raw = localStorage.getItem(TRAY_HEIGHT_KEY);
    if (raw !== null) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        return clampPlanExploreTrayHeight(parsed);
      }
    }
  } catch {
    // ignore corrupt state
  }
  return DEFAULT_TRAY_HEIGHT;
}

export function savePlanExploreTrayHeight(value: number): void {
  try {
    localStorage.setItem(
      TRAY_HEIGHT_KEY,
      String(clampPlanExploreTrayHeight(value)),
    );
  } catch {
    // ignore quota errors
  }
}

const COMMENTS_COLLAPSED_KEY = 'canopy.planExplore.commentsCollapsed.v1';

/** Bottom comments-tray collapse state. Defaults to expanded (false). */
export function loadPlanExploreCommentsCollapsed(): boolean {
  try {
    return localStorage.getItem(COMMENTS_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function savePlanExploreCommentsCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COMMENTS_COLLAPSED_KEY, collapsed ? 'true' : 'false');
  } catch {
    // ignore quota errors
  }
}
