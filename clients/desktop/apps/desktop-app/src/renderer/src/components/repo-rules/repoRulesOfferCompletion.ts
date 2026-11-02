import type {
  RepoRulesOfferOutcome,
  RepoRulesProjectDecision,
} from '@canopy/ui-app/repo-rules';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import {
  repoRulesOfferEligibleIds,
  useRepoRulesModalStore,
} from '@/stores/repoRulesModalStore';
import { evaluateEditorSetupGate } from './editorSetupCompletionGate';

/**
 * Records an offered project's apply or Skip, then reports whether the
 * review keeps choosing or closes.
 */
export function recordRepoRulesOfferDecision(
  workspaceId: string,
  decision: RepoRulesProjectDecision,
  eligibleIds: ReadonlySet<string>,
): RepoRulesOfferOutcome {
  useRepoRulesModalStore.getState().recordOfferDecision(workspaceId, decision);
  const { offer } = useRepoRulesModalStore.getState();
  return offer &&
    evaluateEditorSetupGate(offer, repoRulesOfferEligibleIds(eligibleIds)) ===
      'resolved'
    ? 'close'
    : 'continue';
}

/**
 * A save from a review outside the offer flow: Settings, Project settings, or
 * a single-project entry point. It counts for the offer when it saved an
 * offered project.
 */
export function recordRepoRulesSave(
  result: { readonly workspaceId: string; readonly status: RepoRulesStatus },
  eligibleIds: ReadonlySet<string>,
): void {
  const { offer } = useRepoRulesModalStore.getState();
  if (offer?.memberIds.includes(result.workspaceId)) {
    recordRepoRulesOfferDecision(
      result.workspaceId,
      result.status.enabled ? 'on' : 'off',
      eligibleIds,
    );
    return;
  }
}
