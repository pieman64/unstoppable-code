import { create } from 'zustand';

/**
 * Mirrors the global `groupChildBranchesWithBase` preference into a renderer
 * store so the worktree sidebar reacts immediately when the toggle in Git
 * settings changes, without a preferences reload or an IPC round-trip. Seeded
 * from persisted preferences at startup (see `App.tsx`) and updated optimistically
 * by `GitTab` when the user flips the toggle.
 */
interface BranchGroupingPreferenceState {
  /** When true, the sidebar nests child branches under their base-branch worktree. */
  enabled: boolean;
  /** Loads the persisted preference value. */
  loadEnabled: () => Promise<void>;
  /** Sets the value optimistically (callers persist separately). */
  setEnabled: (enabled: boolean) => void;
}

export const useBranchGroupingPreferenceStore =
  create<BranchGroupingPreferenceState>((set) => ({
    enabled: true,

    loadEnabled: async (): Promise<void> => {
      try {
        const prefs = await window.api.loadPreferences();
        set({ enabled: prefs.groupChildBranchesWithBase ?? true });
      } catch {
        // Preferences unavailable — keep the default-on behavior.
      }
    },

    setEnabled: (enabled: boolean): void => {
      set({ enabled });
    },
  }));
