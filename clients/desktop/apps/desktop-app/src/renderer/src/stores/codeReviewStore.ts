import { create } from 'zustand';
import type {
  ChangedFileInfo,
  FileDiffSource,
} from '@canopy/desktop-shared/types';

export interface CodeReviewTarget {
  projectId: string;
  worktreeId: string;
}

/** Compatibility navigation for existing actions and notifications. No chat host. */
export const useCodeReviewStore = create<{
  openCodeReview: (
    scope: CodeReviewTarget,
    options?: {
      initialFile?: ChangedFileInfo;
      initialSource?: FileDiffSource;
      arm?: boolean;
    },
  ) => Promise<void>;
}>(() => ({
  openCodeReview: async (scope, options): Promise<void> => {
    if (options?.initialFile) {
      const { openFileInDiff } = await import('@/lib/panels/open-file-diff');
      await openFileInDiff(
        scope,
        options.initialFile,
        options.initialSource ?? 'combined',
      );
    } else {
      const { openChangeDiagram } =
        await import('@/lib/panels/chat-panel-sync');
      await openChangeDiagram(`${scope.projectId}/${scope.worktreeId}`);
    }
  },
}));
