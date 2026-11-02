import { create } from 'zustand';
import { useProjectsStore } from './projectsStore';
import type { AppAdvisorRepoRulesModalSource } from '@canopy/desktop-shared/types';
import type { RepoRulesProjectDecision } from '@canopy/ui-app/repo-rules';
import {
  evaluateEditorSetupGate,
  mergeRepoRulesOffer,
  withRepoRulesDecision,
  type RepoRulesOffer,
} from '@/components/repo-rules/editorSetupCompletionGate';

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
   * Opens a multi-project offer (CAN-4980) for these workspaces, for example
   * the new projects an import found Cursor rules in. The review then lists
   * only them and stays open until each is applied or skipped. Ignored with
   * `workspaceId`.
   */
  workspaceIds?: readonly string[];
}

interface RepoRulesModalStore {
  target: RepoRulesModalTarget | null;
  /** Bumps on every open so the host remounts the review and refetches. */
  openCount: number;
  /**
   * The session's multi-project offer and its decisions. It outlives the
   * remounting modal so dismissing the review can't skip the remaining
   * projects; an app restart discards it.
   */
  offer: RepoRulesOffer | null;
  /** Frozen eligible membership for each session offer, including old toasts. */
  offerMemberships: Readonly<Record<string, readonly string[]>>;
  open: (target: RepoRulesModalTarget) => void;
  close: () => void;
  recordOfferDecision: (
    workspaceId: string,
    decision: RepoRulesProjectDecision,
  ) => void;
}

/**
 * App-wide host state for the Cursor rules review (CAN-2053). Settings, the
 * Getting started checklist, Project Settings, import results, and App
 * Advisor all open the same flow through {@link openRepoRulesModal}.
 */
export const useRepoRulesModalStore = create<RepoRulesModalStore>((set) => ({
  target: null,
  openCount: 0,
  offer: null,
  offerMemberships: {},
  open: (target): void =>
    set((state) => {
      if (target.workspaceId !== undefined || !target.workspaceIds)
        return { target, openCount: state.openCount + 1 };
      const codeIds = new Set(
        useProjectsStore
          .getState()
          .projects.filter((project) => project.type !== 'cowork')
          .map((project) => project.id),
      );
      const key = JSON.stringify(
        Array.from(new Set(target.workspaceIds)).sort(),
      );
      const members =
        state.offerMemberships[key] ??
        target.workspaceIds.filter((id) => codeIds.has(id));
      const pending =
        state.offer !== null &&
        evaluateEditorSetupGate(
          state.offer,
          repoRulesOfferEligibleIds(codeIds),
        ) === 'pending';
      const offer = mergeRepoRulesOffer(
        pending
          ? state.offer
          : { memberIds: [], decisions: state.offer?.decisions ?? {} },
        members,
      );
      return {
        target,
        openCount: state.openCount + 1,
        offer,
        offerMemberships: { ...state.offerMemberships, [key]: members },
      };
    }),
  close: (): void => set({ target: null }),
  recordOfferDecision: (workspaceId, decision): void =>
    set((state) =>
      state.offer
        ? { offer: withRepoRulesDecision(state.offer, workspaceId, decision) }
        : {},
    ),
}));

/** A failed/unfinished workspace load is not evidence of project removal. */
export function repoRulesOfferEligibleIds(
  codeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const { failedWorkspaceIds, isLoading } = useProjectsStore.getState();
  const ids = new Set(codeIds);
  for (const id of useRepoRulesModalStore.getState().offer?.memberIds ?? [])
    if (isLoading || failedWorkspaceIds.has(id)) ids.add(id);
  return ids;
}

export function openRepoRulesModal(target: RepoRulesModalTarget): void {
  useRepoRulesModalStore.getState().open(target);
}

export function closeRepoRulesModal(): void {
  useRepoRulesModalStore.getState().close();
}
