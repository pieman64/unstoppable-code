import type { MemoryDropReason } from '@canopy/protocol/memory';
import {
  ackOrgMemoryDelivered,
  type OrgMemoryDeliveryAckDetails,
  type OrgMemoryFetchResult,
} from './memory-client';

/**
 * Per-turn delivery outcome tracker for the organization-memory fetch
 * (CAN-2252). One tracker is created where the fetch starts and guarantees
 * exactly-one-ack semantics for the search it observes: the first delivered
 * or dropped ack settles the tracker and every later ack attempt is a no-op.
 *
 * The drop continuations (`noteRaceLoss`, `noteDispatchExit`) attach to the
 * fetch result rather than firing immediately, because a drop is only worth
 * attributing when the search actually produced an injectable block — a
 * `searchId` with at least one fact. Attach order is precedence order: a race
 * loss noted before the dispatch exits stays a `race_timeout` even though the
 * exit continuation also observes the late result.
 *
 * Every ack is fire-and-forget by contract (`ackOrgMemoryDelivered` never
 * throws) and must never gate or delay the turn.
 */
export interface OrgMemoryDeliveryTracker {
  /**
   * Settle with a delivered ack; no-op if the tracker already settled. The
   * ack goes to the org the search was made in (CAN-3457).
   */
  ackDelivered(organizationExternalId: string, searchId: string): void;
  /** Settle with a dropped ack; no-op if the tracker already settled. */
  ackDropped(
    organizationExternalId: string,
    searchId: string,
    dropReason: MemoryDropReason,
  ): void;
  /**
   * The memory race settled without a result. Attributes a late result that
   * would have been injected as a `race_timeout` drop, with the elapsed time
   * at which the result actually arrived.
   */
  noteRaceLoss(): void;
  /**
   * The dispatch exited (return or throw). Call from a `finally` around the
   * dispatch body so every exit path settles the tracker: if no delivered or
   * dropped ack fired first, an injectable result — already resolved or still
   * in flight — is attributed as a `turn_aborted` drop.
   */
  noteDispatchExit(): void;
}

export interface OrgMemoryDeliveryTrackerOptions {
  /** The turn's memory fetch; a rejection is treated as "no result". */
  resultPromise: Promise<OrgMemoryFetchResult | null>;
  /** Anchor for `clientElapsedMs`, shared with the race budget. */
  dispatchStartedAt: number;
  /** Telemetry-clamped local chat id stamped on every ack. */
  clientChatId: string;
  /** Ack transport override for tests; defaults to the real client ack. */
  ack?: (
    organizationExternalId: string,
    searchId: string,
    details?: OrgMemoryDeliveryAckDetails,
  ) => Promise<void>;
}

export function createOrgMemoryDeliveryTracker(
  options: OrgMemoryDeliveryTrackerOptions,
): OrgMemoryDeliveryTracker {
  const ack = options.ack ?? ackOrgMemoryDelivered;
  let settled = false;
  /** Returns true exactly once; the winning caller owns the single ack. */
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    return true;
  };
  const commonDetails = (): {
    clientElapsedMs: number;
    clientChatId: string;
  } => ({
    // Elapsed at the ack decision — for late results, when the result
    // actually arrived — so the race floor can be tuned against how late
    // the losers really are.
    clientElapsedMs: Date.now() - options.dispatchStartedAt,
    clientChatId: options.clientChatId,
  });
  const safeResult: Promise<OrgMemoryFetchResult | null> =
    options.resultPromise.catch((): null => null);
  const attachDropContinuation = (dropReason: MemoryDropReason): void => {
    void safeResult.then((result): void => {
      // Only a block that would have been injected is worth attributing:
      // a searchId with at least one fact.
      if (result?.searchId === undefined || result.facts.length === 0) return;
      if (!settle()) return;
      void ack(result.organizationExternalId, result.searchId, {
        outcome: 'dropped',
        dropReason,
        ...commonDetails(),
      });
    });
  };
  return {
    ackDelivered(organizationExternalId: string, searchId: string): void {
      if (!settle()) return;
      void ack(organizationExternalId, searchId, {
        outcome: 'delivered',
        ...commonDetails(),
      });
    },
    ackDropped(
      organizationExternalId: string,
      searchId: string,
      dropReason: MemoryDropReason,
    ): void {
      if (!settle()) return;
      void ack(organizationExternalId, searchId, {
        outcome: 'dropped',
        dropReason,
        ...commonDetails(),
      });
    },
    noteRaceLoss(): void {
      attachDropContinuation('race_timeout');
    },
    noteDispatchExit(): void {
      // Settled means the outcome is already attributed (delivered,
      // send_failed, ...); skip attaching a continuation that could never
      // win. An unsettled exit attaches even when a race loss already did:
      // the race_timeout continuation attached first, so it takes precedence
      // on the same result.
      if (settled) return;
      attachDropContinuation('turn_aborted');
    },
  };
}
