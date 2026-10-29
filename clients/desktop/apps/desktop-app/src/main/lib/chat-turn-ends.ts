import type { PersistedChatTab } from '@canopy/desktop-shared/types';

export type TurnEnds = NonNullable<PersistedChatTab['turnEnds']>;
type TurnEndOutcome = TurnEnds[string]['outcome'];

/** The most turn ends a chat keeps. */
export const TURN_END_LIMIT = 64;

/**
 * Records how the turn of `userMessageId` ended. Past the limit, the oldest
 * completed ends go first, since acceptance order also reports a completed
 * turn, then the oldest of the rest. The end of `keep` is never dropped.
 */
export function withTurnEnd(
  ends: TurnEnds | undefined,
  userMessageId: string,
  outcome: TurnEndOutcome,
  endedAt: number,
  keep?: string,
): TurnEnds {
  const next: TurnEnds = { ...ends, [userMessageId]: { outcome, endedAt } };
  const ids = Object.keys(next);
  if (ids.length <= TURN_END_LIMIT) return next;
  const evicted = ids
    .filter((id) => id !== userMessageId && id !== keep)
    .sort((left, right) => {
      const a = next[left];
      const b = next[right];
      const byOutcome =
        Number(b?.outcome === 'completed') - Number(a?.outcome === 'completed');
      return byOutcome || (a?.endedAt ?? 0) - (b?.endedAt ?? 0);
    })
    .slice(0, ids.length - TURN_END_LIMIT);
  for (const id of evicted) Reflect.deleteProperty(next, id);
  return next;
}

/** Drops the recorded end of a turn that runs again. */
export function withoutTurnEnd(
  ends: TurnEnds | undefined,
  userMessageId: string,
): TurnEnds | undefined {
  if (!ends || !Object.prototype.hasOwnProperty.call(ends, userMessageId)) {
    return ends;
  }
  const next = { ...ends };
  Reflect.deleteProperty(next, userMessageId);
  return Object.keys(next).length > 0 ? next : undefined;
}

/** How the turn of `userMessageId` ended, when its chat recorded it. */
export function recordedTurnEnd(
  ends: TurnEnds | undefined,
  userMessageId: string,
): TurnEndOutcome | undefined {
  if (!ends || !Object.prototype.hasOwnProperty.call(ends, userMessageId)) {
    return undefined;
  }
  const outcome: unknown = ends[userMessageId]?.outcome;
  return outcome === 'completed' ||
    outcome === 'failed' ||
    outcome === 'cancelled'
    ? outcome
    : undefined;
}
