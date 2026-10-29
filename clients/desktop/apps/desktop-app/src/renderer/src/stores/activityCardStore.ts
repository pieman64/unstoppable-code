import { create } from 'zustand';

export const ACTIVITY_CARD_ELEMENT_ID = 'worktree-activity-card';

/**
 * Where the shown/hidden choice per worktree is kept, so it survives a
 * restart. A renderer-only UI choice, like the other `canopy.*` keys.
 */
export const ACTIVITY_CARD_OPEN_STORAGE_KEY =
  'canopy.activityCard.openWorktrees';

/** The worktrees whose card is shown, by worktree key. */
type OpenWorktrees = Readonly<Record<string, true>>;

function readOpenWorktrees(): OpenWorktrees {
  try {
    const raw = window.localStorage.getItem(ACTIVITY_CARD_OPEN_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const open: Record<string, true> = {};
    for (const key of parsed) {
      if (typeof key === 'string') open[key] = true;
    }
    return open;
  } catch {
    return {};
  }
}

function writeOpenWorktrees(open: OpenWorktrees): void {
  try {
    window.localStorage.setItem(
      ACTIVITY_CARD_OPEN_STORAGE_KEY,
      JSON.stringify(Object.keys(open)),
    );
  } catch {
    // Storage full or unavailable: the choice still holds for this session.
  }
}

interface ActivityCardState {
  /**
   * Each worktree remembers whether its card is shown, so switching
   * worktrees shows each one as it was left. A worktree never toggled starts
   * hidden.
   */
  readonly openWorktrees: OpenWorktrees;
  readonly toggle: (worktreeKey: string) => void;
  /** Shows the card for `worktreeKey`, remembering the choice like a toggle. */
  readonly show: (worktreeKey: string) => void;
}

export const useActivityCardStore = create<ActivityCardState>((set) => ({
  openWorktrees: readOpenWorktrees(),
  toggle: (worktreeKey): void =>
    set((state) => {
      const { [worktreeKey]: wasOpen, ...rest } = state.openWorktrees;
      const openWorktrees: OpenWorktrees = wasOpen
        ? rest
        : { ...state.openWorktrees, [worktreeKey]: true };
      writeOpenWorktrees(openWorktrees);
      return { openWorktrees };
    }),
  show: (worktreeKey): void =>
    set((state) => {
      if (state.openWorktrees[worktreeKey]) return state;
      const openWorktrees: OpenWorktrees = {
        ...state.openWorktrees,
        [worktreeKey]: true,
      };
      writeOpenWorktrees(openWorktrees);
      return { openWorktrees };
    }),
}));

/** Whether the card is shown for `worktreeKey`. */
export function isActivityCardOpen(
  state: Pick<ActivityCardState, 'openWorktrees'>,
  worktreeKey: string | null,
): boolean {
  return worktreeKey !== null && state.openWorktrees[worktreeKey] === true;
}
