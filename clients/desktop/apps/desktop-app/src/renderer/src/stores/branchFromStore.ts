import { create } from 'zustand';

export type BranchFromChoice = 'commit-first' | 'do-not-commit';

interface PendingBranchFromConfirmation {
  confirmationId: string;
  projectId: string;
  worktreeId: string;
  resolve: (choice: BranchFromChoice | null) => void;
}

function createBranchFromConfirmationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `branch-from-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

interface BranchFromState {
  pending: PendingBranchFromConfirmation | null;
  requestConfirmation: (
    projectId: string,
    worktreeId: string,
  ) => Promise<BranchFromChoice | null>;
  resolveConfirmation: (choice: BranchFromChoice | null) => void;
}

export const useBranchFromStore = create<BranchFromState>((set, get) => ({
  pending: null,

  requestConfirmation: (
    projectId,
    worktreeId,
  ): Promise<BranchFromChoice | null> =>
    new Promise<BranchFromChoice | null>((resolve) => {
      // Only one confirmation can be visible at a time. If another branch
      // request somehow arrives first, cancel it rather than leaving its
      // caller waiting forever.
      get().pending?.resolve(null);
      set({
        pending: {
          confirmationId: createBranchFromConfirmationId(),
          projectId,
          worktreeId,
          resolve,
        },
      });
    }),

  resolveConfirmation: (choice): void => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(choice);
  },
}));
