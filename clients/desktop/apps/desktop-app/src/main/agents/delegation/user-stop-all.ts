import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';

/** The broker calls a user stop-all makes. */
export interface StopAllBroker {
  list(parent: DelegationParentContext): readonly AgentDelegationSnapshot[];
  stop(
    parent: DelegationParentContext,
    id: string,
    reason: 'user_cancelled',
  ): Promise<AgentDelegationResult<AgentDelegationSnapshot>>;
  activeCount(parent: DelegationParentContext): number;
  queuedCount(parent: DelegationParentContext): number;
}

/** The chat a stop-all fences: its spawn fence, notices and watchers. */
export interface StopAllChat {
  holdStopAllFence(): () => void;
  fenceNotices(): Promise<void>;
  nextActivity(ms: number): Promise<void>;
  retireWatchers(): Promise<void>;
}

/** How a stop-all stops the top delegation of one live subtree; `brokerStop` is the default. */
export type StopAllRootStop = (
  snapshot: AgentDelegationSnapshot,
  brokerStop: () => Promise<AgentDelegationResult<unknown>>,
) => Promise<AgentDelegationResult<unknown>>;

/** The delegations one stop-all stopped, in any round. */
export interface StopAllOutcome {
  readonly stopped: number;
  readonly delegationIds: readonly string[];
}

/** Bounds a user stop-all's rounds of listing, stopping and settling. */
const STOP_ALL_MAX_ROUNDS = 20;
/** How long a stop-all waits between rounds for in-flight admissions. */
const STOP_ALL_SETTLE_MS = 50;

export function isLiveDelegation(snapshot: AgentDelegationSnapshot): boolean {
  return snapshot.status === 'pending' || snapshot.status === 'running';
}

/** The top live delegation of each live subtree, with the live ids it covers. */
function liveSubtrees(
  snapshots: readonly AgentDelegationSnapshot[],
): Map<string, string[]> {
  const byId = new Map(
    snapshots.map((snapshot) => [snapshot.delegationId, snapshot]),
  );
  const live = new Set(
    snapshots.filter(isLiveDelegation).map((snapshot) => snapshot.delegationId),
  );
  // A live delegation under a live ancestor is stopped by that ancestor's
  // cascade, so stop only the top live delegation of each subtree.
  const subtreeOf = (id: string): string => {
    let top = id;
    let ancestor = byId.get(id)?.parentDelegationId;
    for (let depth = 0; depth < 10 && ancestor; depth += 1) {
      if (live.has(ancestor)) top = ancestor;
      ancestor = byId.get(ancestor)?.parentDelegationId;
    }
    return top;
  };
  const members = new Map<string, string[]>();
  for (const id of Array.from(live)) {
    const top = subtreeOf(id);
    members.set(top, [...(members.get(top) ?? []), id]);
  }
  return members;
}

type StopAllResult = AgentDelegationResult<StopAllOutcome>;

const inFlight = new Map<string, Promise<StopAllResult>>();

/**
 * Runs one stop-all per chat key: a stop-all requested while one runs for the
 * same chat joins it and reports the same delegations, so it stops nothing
 * more and is never refused by the first one's fence (CAN-6000).
 */
export function joinStopAll(
  key: string,
  start: () => Promise<StopAllResult>,
): Promise<StopAllResult> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = start().finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

/**
 * Stops every live delegation in the chat, each subtree once. The chat's
 * stop-all fence refuses new spawns until nothing is live or in flight, and
 * the chat is listed again after every round of stops, so a spawn admitted
 * after a listing is stopped as well. The outcome covers every delegation
 * stopped in any round. `stopRoot` replaces the broker stop of each
 * subtree's top delegation; App Advisor cancels its core.agent.subagent.run
 * through it.
 */
export async function stopAllUnderFence(options: {
  broker: StopAllBroker;
  parent: DelegationParentContext;
  chat: StopAllChat;
  stopRoot?: StopAllRootStop;
  settleMs?: number;
}): Promise<StopAllResult> {
  const { chat } = options;
  const release = chat.holdStopAllFence();
  try {
    await chat.fenceNotices();
    // No stopped delegate may be woken by a watch on another one.
    await chat.retireWatchers();
    const result = await stopEveryLiveSubtree(options);
    if (result.ok) await chat.retireWatchers();
    return result;
  } finally {
    release();
  }
}

async function stopEveryLiveSubtree({
  broker,
  parent,
  chat,
  stopRoot = (_snapshot, brokerStop) => brokerStop(),
  settleMs = STOP_ALL_SETTLE_MS,
}: Parameters<typeof stopAllUnderFence>[0]): Promise<
  AgentDelegationResult<StopAllOutcome>
> {
  const stopped = new Set<string>();
  const outcome = (): StopAllOutcome => ({
    stopped: stopped.size,
    delegationIds: Array.from(stopped).sort(),
  });
  for (let round = 0; round < STOP_ALL_MAX_ROUNDS; round += 1) {
    const snapshots = broker.list(parent);
    const subtrees = liveSubtrees(snapshots);
    if (subtrees.size === 0) {
      // A spawn admitted before the fence may not be listed yet: the broker
      // still counts it while it is admitted and durably recorded.
      if (broker.activeCount(parent) + broker.queuedCount(parent) === 0)
        return { ok: true, value: outcome() };
      await chat.nextActivity(settleMs);
      continue;
    }
    const byId = new Map(
      snapshots.map((snapshot) => [snapshot.delegationId, snapshot]),
    );
    const outcomes = await Promise.all(
      Array.from(subtrees.keys(), (id) => {
        const brokerStop = (): Promise<AgentDelegationResult<unknown>> =>
          broker.stop(parent, id, 'user_cancelled');
        const snapshot = byId.get(id);
        return snapshot ? stopRoot(snapshot, brokerStop) : brokerStop();
      }),
    );
    const failure = outcomes.find((result) => !result.ok);
    if (failure && !failure.ok) return failure;
    for (const members of Array.from(subtrees.values()))
      for (const id of members) stopped.add(id);
  }
  // Out of rounds: succeed only if nothing is left live or still being
  // admitted. A spawn still in preflight may not be listed yet, so the
  // broker's active/queued counts must also be zero before reporting
  // success, matching the settle-path check above.
  if (
    broker.list(parent).some(isLiveDelegation) ||
    broker.activeCount(parent) + broker.queuedCount(parent) > 0
  )
    return {
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'Some delegates are still running. Try again.',
        retryable: true,
      },
    };
  return { ok: true, value: outcome() };
}
