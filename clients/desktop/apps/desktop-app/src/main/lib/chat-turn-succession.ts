import type { PersistedChatTab } from '@canopy/desktop-shared/types';

export type InterruptedTurns = NonNullable<
  PersistedChatTab['interruptedTurns']
>;

/** Records a turn an app restart interrupted, awaiting a resume. */
export function withInterruptedTurn(
  turns: InterruptedTurns | undefined,
  userMessageId: string,
): InterruptedTurns {
  return { ...turns, [userMessageId]: turns?.[userMessageId] ?? {} };
}

/**
 * Settles every interrupted turn still awaiting a resume when the turn of
 * `userMessageId` starts: a resume continues them, any other turn abandons
 * them. Returns the record and the turns it abandoned.
 */
export function succeedInterruptedTurns(
  turns: InterruptedTurns | undefined,
  userMessageId: string,
  resumes: boolean,
): { turns: InterruptedTurns | undefined; abandoned: string[] } {
  if (!turns) return { turns, abandoned: [] };
  const abandoned: string[] = [];
  let next: InterruptedTurns | undefined;
  for (const [id, turn] of Object.entries(turns)) {
    if (id === userMessageId || turn.resumedBy || turn.abandoned) continue;
    next ??= { ...turns };
    if (resumes) next[id] = { resumedBy: userMessageId };
    else {
      next[id] = { abandoned: true };
      abandoned.push(id);
    }
  }
  return { turns: next ?? turns, abandoned };
}

/**
 * The turn that carries a watched turn on: the watched turn itself, or the
 * last resume in its chain of resumes. `awaitingResume` when that turn was
 * interrupted and nothing resumed it yet; `abandoned` when another turn
 * started instead.
 */
export function resolveTurnSuccession(
  turns: InterruptedTurns | undefined,
  userMessageId: string,
): { userMessageId: string; awaitingResume: boolean; abandoned: boolean } {
  let current = userMessageId;
  const seen = new Set<string>();
  for (;;) {
    const turn = turns?.[current];
    if (!turn || seen.has(current)) {
      return {
        userMessageId: current,
        awaitingResume: false,
        abandoned: false,
      };
    }
    seen.add(current);
    if (turn.abandoned) {
      return { userMessageId: current, awaitingResume: false, abandoned: true };
    }
    if (!turn.resumedBy) {
      return { userMessageId: current, awaitingResume: true, abandoned: false };
    }
    current = turn.resumedBy;
  }
}

/** The interrupted turns a turn resumes, nearest first. */
export function resumedTurns(
  turns: InterruptedTurns | undefined,
  userMessageId: string,
): string[] {
  const chain: string[] = [];
  let current = userMessageId;
  for (;;) {
    const previous = Object.entries(turns ?? {}).find(
      ([id, turn]) => turn.resumedBy === current && !chain.includes(id),
    )?.[0];
    if (!previous || previous === userMessageId) return chain;
    chain.push(previous);
    current = previous;
  }
}
