import { create } from 'zustand';

/**
 * Live "graph building" indicator state, keyed `${projectId}/${worktreeId}`.
 * Backs the gray hub badge in the worktree row
 * (`packages/ui-shared/src/components/WorktreeRow.tsx`'s `graphBuildStatus`
 * prop) while a code-graph build is in flight for that worktree.
 *
 * Deliberately has NO `scriptsStore`-style `loadedWorktreeKeys` gate: the
 * sidebar badge must render for any worktree row, not just the currently
 * selected/loaded one, so every `codeGraphBuildStatusChanged` IPC event is
 * accepted regardless of whether that worktree has ever been opened.
 */
interface CodeGraphBuildState {
  /** `true` for a key currently building; absent keys are idle. */
  building: Record<string, boolean>;
  /** Sets a key `true` (building) or removes it (idle) — keeps the map small. */
  setBuilding: (
    projectId: string,
    worktreeId: string,
    building: boolean,
  ) => void;
}

function buildKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

export const useCodeGraphBuildStore = create<CodeGraphBuildState>((set) => ({
  building: {},
  setBuilding: (projectId, worktreeId, building): void => {
    const key = buildKey(projectId, worktreeId);
    set((state) => {
      if (building) {
        if (state.building[key] === true) {
          return state;
        }
        return { building: { ...state.building, [key]: true } };
      }
      if (!(key in state.building)) {
        return state;
      }
      const next = { ...state.building };
      delete next[key];
      return { building: next };
    });
  },
}));
