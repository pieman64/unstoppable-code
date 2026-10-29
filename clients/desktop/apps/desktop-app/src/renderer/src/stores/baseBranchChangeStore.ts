import { create } from 'zustand';

export type BaseBranchChangeChoice = 'update-pr' | 'local-only';

export interface PendingBaseBranchChange {
  requestId?: string;
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoName: string;
  baseBranch: string;
  prNumber: number;
  resolve: (choice: BaseBranchChangeChoice | null) => void;
}

interface BaseBranchChangeState {
  pending: PendingBaseBranchChange | null;
  requestConfirmation: (
    pending: Omit<PendingBaseBranchChange, 'resolve'>,
  ) => Promise<BaseBranchChangeChoice | null>;
  resolveConfirmation: (choice: BaseBranchChangeChoice | null) => void;
  cancelConfirmation: (requestId: string) => void;
}

export const useBaseBranchChangeStore = create<BaseBranchChangeState>(
  (set, get) => ({
    pending: null,
    requestConfirmation: (request): Promise<BaseBranchChangeChoice | null> =>
      new Promise<BaseBranchChangeChoice | null>((resolve) => {
        get().pending?.resolve(null);
        set({ pending: { ...request, resolve } });
      }),
    resolveConfirmation: (choice): void => {
      const pending = get().pending;
      if (!pending) return;
      set({ pending: null });
      pending.resolve(choice);
    },
    cancelConfirmation: (requestId): void => {
      const pending = get().pending;
      if (!pending || pending.requestId !== requestId) return;
      set({ pending: null });
      pending.resolve(null);
    },
  }),
);
