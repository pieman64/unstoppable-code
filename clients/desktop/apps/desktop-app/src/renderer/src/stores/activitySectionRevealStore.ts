import { create } from 'zustand';
import type { ActivitySectionId } from '@canopy/desktop-shared/types';

/**
 * Requests to expand one section of a worktree's Activity panel.
 *
 * A section's collapsed state belongs to its mounted card (the shared
 * `PanelSection`), so code outside the panel cannot set it directly.
 * {@link ActivitySectionRevealState.requestSectionExpand} records a new
 * request id instead; the Activity panel passes the latest id to the section
 * as `expandRequest`, and the card expands whenever that id changes. Later
 * collapse and expand clicks stay with the user.
 */
export interface ActivitySectionRevealState {
  /** `${projectId}/${worktreeId}` -> section id -> latest request id. */
  expandRequests: Record<string, Partial<Record<ActivitySectionId, number>>>;
  /** Ask `sectionId` in `worktreeKey`'s Activity panel to expand. */
  requestSectionExpand: (
    worktreeKey: string,
    sectionId: ActivitySectionId,
  ) => void;
}

let lastExpandRequestId = 0;

export const useActivitySectionRevealStore = create<ActivitySectionRevealState>(
  (set) => ({
    expandRequests: {},
    requestSectionExpand: (worktreeKey, sectionId): void => {
      lastExpandRequestId += 1;
      const requestId = lastExpandRequestId;
      set((state) => ({
        expandRequests: {
          ...state.expandRequests,
          [worktreeKey]: {
            ...state.expandRequests[worktreeKey],
            [sectionId]: requestId,
          },
        },
      }));
    },
  }),
);
