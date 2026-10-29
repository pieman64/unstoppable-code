import { create } from 'zustand';

export interface BaseBranchAlignmentDrift {
  repoId: string;
  repoName: string;
  localBaseBranch: string;
  prBaseBranch: string;
  prNumber: number;
}

interface PendingBaseBranchAlignment {
  confirmationId: string;
  projectId: string;
  worktreeId: string;
  drifts: BaseBranchAlignmentDrift[];
  resolve: (confirmed: boolean) => void;
}

function createConfirmationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `base-branch-alignment-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

interface BaseBranchAlignmentState {
  pending: PendingBaseBranchAlignment | null;
  requestConfirmation: (
    projectId: string,
    worktreeId: string,
    drifts: BaseBranchAlignmentDrift[],
  ) => Promise<boolean>;
  resolveConfirmation: (confirmed: boolean) => void;
}

export const useBaseBranchAlignmentStore = create<BaseBranchAlignmentState>(
  (set, get) => ({
    pending: null,

    requestConfirmation: (projectId, worktreeId, drifts): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        get().pending?.resolve(false);
        set({
          pending: {
            confirmationId: createConfirmationId(),
            projectId,
            worktreeId,
            drifts: [...drifts],
            resolve,
          },
        });
      }),

    resolveConfirmation: (confirmed): void => {
      const pending = get().pending;
      if (!pending) return;
      set({ pending: null });
      pending.resolve(confirmed);
    },
  }),
);
