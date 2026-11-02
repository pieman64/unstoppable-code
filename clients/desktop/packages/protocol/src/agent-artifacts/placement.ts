import type { AgentArtifactReceiptV1 } from './index';

/**
 * How a turn relates to a receipt it lists: a `pipeline.watch` or
 * `github.watch` receipt only watches its run; every other receipt is
 * something the turn did.
 */
export type AgentArtifactTurnRelation = 'launched' | 'watching';

export function agentArtifactTurnRelation(
  receipt: AgentArtifactReceiptV1,
): AgentArtifactTurnRelation {
  return receipt.operation === 'pipeline.watch' ||
    receipt.operation === 'github.watch'
    ? 'watching'
    : 'launched';
}

/** Where a chat's Agent activity receipts render (CAN-4690). */
export interface AgentActivityPlacement {
  /** What each turn's transcript box lists. */
  readonly byTurn: Readonly<Record<string, readonly AgentArtifactReceiptV1[]>>;
  /**
   * The live runs the turns list, one receipt per run in transcript order.
   * The host's live section renders them instead of the turns.
   */
  readonly live: readonly AgentArtifactReceiptV1[];
}

function isRunReceipt(receipt: AgentArtifactReceiptV1): boolean {
  return (
    receipt.kind === 'pipeline_run' || receipt.kind === 'github_workflow_run'
  );
}

function sameReceipts(
  left: readonly AgentArtifactReceiptV1[] | undefined,
  right: readonly AgentArtifactReceiptV1[],
): left is readonly AgentArtifactReceiptV1[] {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((receipt, index) => receipt === right[index])
  );
}

/**
 * Places each pipeline and GitHub run a chat's turns list in exactly one
 * spot, keyed by the run's `dedupeKey`:
 * - A run in `liveRunKeys` belongs to the host's live section: no turn lists
 *   it, and `live` carries one receipt for it (the latest receipt a turn
 *   launched it with, else the latest that watched it). A host without a
 *   live section passes no keys.
 * - A finished run is listed once: in the latest turn that launched it
 *   (ran, retried or resumed it), else in the latest turn that lists it.
 *
 * Other receipts (capability tiles, automation runs) stay in every turn that
 * lists them. A turn whose receipts are unchanged keeps its input array, and
 * `previous` lets unchanged results keep their identity, so memoized turns
 * skip re-rendering.
 */
export function placeAgentActivity(
  byTurn: Readonly<Record<string, readonly AgentArtifactReceiptV1[]>>,
  turnIds: readonly string[],
  liveRunKeys: ReadonlySet<string>,
  previous?: AgentActivityPlacement,
): AgentActivityPlacement {
  const homeTurn = new Map<string, string>();
  const homeIsLaunch = new Set<string>();
  const liveReceipt = new Map<string, AgentArtifactReceiptV1>();
  for (const turnId of turnIds) {
    for (const receipt of byTurn[turnId] ?? []) {
      if (!isRunReceipt(receipt)) continue;
      const key = receipt.dedupeKey;
      const launched = agentArtifactTurnRelation(receipt) === 'launched';
      if (launched || !homeIsLaunch.has(key)) {
        homeTurn.set(key, turnId);
        if (liveRunKeys.has(key)) liveReceipt.set(key, receipt);
      }
      if (launched) homeIsLaunch.add(key);
    }
  }

  let changed = previous === undefined;
  const placedByTurn: Record<string, readonly AgentArtifactReceiptV1[]> = {};
  for (const turnId of turnIds) {
    const receipts = byTurn[turnId];
    if (!receipts) continue;
    const kept = receipts.filter(
      (receipt) =>
        !isRunReceipt(receipt) ||
        (!liveRunKeys.has(receipt.dedupeKey) &&
          homeTurn.get(receipt.dedupeKey) === turnId &&
          (agentArtifactTurnRelation(receipt) === 'launched' ||
            !homeIsLaunch.has(receipt.dedupeKey))),
    );
    const prior = previous?.byTurn[turnId];
    const placed =
      kept.length === receipts.length
        ? receipts
        : sameReceipts(prior, kept)
          ? prior
          : kept;
    if (placed !== prior) changed = true;
    placedByTurn[turnId] = placed;
  }
  if (
    previous &&
    Object.keys(previous.byTurn).length !== Object.keys(placedByTurn).length
  ) {
    changed = true;
  }

  const liveList = Array.from(liveReceipt.values());
  const live = sameReceipts(previous?.live, liveList)
    ? previous.live
    : liveList;
  if (live !== previous?.live) changed = true;

  return !changed && previous ? previous : { byTurn: placedByTurn, live };
}
