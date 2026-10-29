import { create } from 'zustand';
import type { AppAdvisorRepoRulesModalSource } from '@canopy/desktop-shared/types';

export interface RepoRulesModalTarget {
  /** Where the review was opened from; reported in the UI snapshot. */
  source: AppAdvisorRepoRulesModalSource;
  /**
   * The workspace to review. Omit it when the entry point has no workspace
   * context; the review then asks the user to choose one rather than picking
   * one from collection order.
   */
  workspaceId?: string;
  /**
   * Narrows the review's project choice to these workspaces, for example the
   * new projects an offer found Cursor rules in. Ignored with `workspaceId`,
   * and when none of them are still code projects.
   */
  workspaceIds?: readonly string[];
}

interface RepoRulesModalStore {
  target: RepoRulesModalTarget | null;
  /** Bumps on every open so the host remounts the review and refetches. */
  openCount: number;
  open: (target: RepoRulesModalTarget) => void;
  close: () => void;
}

/**
 * App-wide host state for the Cursor rules review (CAN-2053). Settings, the
 * Getting started checklist, Project Settings, import results, and App
 * Advisor all open the same flow through {@link openRepoRulesModal}.
 */
export const useRepoRulesModalStore = create<RepoRulesModalStore>((set) => ({
  target: null,
  openCount: 0,
  open: (target): void =>
    set((state) => ({ target, openCount: state.openCount + 1 })),
  close: (): void => set({ target: null }),
}));

export function openRepoRulesModal(target: RepoRulesModalTarget): void {
  useRepoRulesModalStore.getState().open(target);
}

export function closeRepoRulesModal(): void {
  useRepoRulesModalStore.getState().close();
}
