import type { RepoRulesProjectDecision } from '@canopy/ui-app/repo-rules';

/**
 * A multi-project Cursor rules offer for this app session (CAN-4980). The
 * membership is captured when the offer opens and grows only when another
 * offer merges into it; it never follows the project list.
 */
export interface RepoRulesOffer {
  /** Offered workspace ids, deduplicated, in offer order. */
  readonly memberIds: readonly string[];
  /** The latest decision for each offered project. */
  readonly decisions: Readonly<
    Partial<Record<string, RepoRulesProjectDecision>>
  >;
}

/**
 * - `pending`: an offered project that is still a code project has no
 *   decision, so `import-editor-setup` stays open.
 * - `resolved`: every remaining offered project was applied or skipped.
 * - `abandoned`: no offered project remains, which completes nothing.
 */
export type EditorSetupGateState = 'pending' | 'resolved' | 'abandoned';

/** Offered projects that are still code projects, in offer order. */
export function activeOfferMemberIds(
  offer: RepoRulesOffer,
  eligibleIds: ReadonlySet<string>,
): string[] {
  return offer.memberIds.filter((id) => eligibleIds.has(id));
}

/**
 * Whether the offer lets `import-editor-setup` complete. Only current
 * members count: decisions for removed or unrelated projects never resolve
 * it, and an empty remainder is abandoned rather than resolved.
 */
export function evaluateEditorSetupGate(
  offer: RepoRulesOffer,
  eligibleIds: ReadonlySet<string>,
): EditorSetupGateState {
  const active = activeOfferMemberIds(offer, eligibleIds);
  if (active.length === 0) return 'abandoned';
  return active.every((id) => offer.decisions[id] !== undefined)
    ? 'resolved'
    : 'pending';
}

/**
 * Starts an offer, or adds a later offer's projects to the current one
 * without losing its decisions or repeating members.
 */
export function mergeRepoRulesOffer(
  offer: RepoRulesOffer | null,
  workspaceIds: readonly string[],
): RepoRulesOffer {
  const memberIds = [...(offer?.memberIds ?? [])];
  for (const id of workspaceIds)
    if (!memberIds.includes(id)) memberIds.push(id);
  return { memberIds, decisions: offer?.decisions ?? {} };
}

/** Records a member's latest decision; ignores projects outside the offer. */
export function withRepoRulesDecision(
  offer: RepoRulesOffer,
  workspaceId: string,
  decision: RepoRulesProjectDecision,
): RepoRulesOffer {
  if (!offer.memberIds.includes(workspaceId)) return offer;
  return {
    memberIds: offer.memberIds,
    decisions: { ...offer.decisions, [workspaceId]: decision },
  };
}
