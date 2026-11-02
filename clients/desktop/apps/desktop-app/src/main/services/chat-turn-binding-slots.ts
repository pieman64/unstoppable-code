/**
 * Host binding slots (contracts §9.7). A canonical turn binds at most 64
 * distinct inputs, so a steer reserves a slot before the provider sees it;
 * past 64 the input waits in the host queue for the next turn.
 */
import type { ChatTurnStateScope } from './chat-turn-state-handoff';
import { getChatTurnOwnership } from './chat-turn-ownership';

const MAX_BOUND_INPUTS = 64;

/** Each chat's reservations, held for its current turn (unknown before its start). */
const reservations = new Map<
  string,
  { turnId: string | undefined; inputIds: Set<string> }
>();

function scopeKey(scope: ChatTurnStateScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId, scope.chatId]);
}

/** The current turn's bound and reserved inputs; a settled turn's lapse. */
function currentSlots(scope: ChatTurnStateScope): {
  taken: Set<string>;
  reserved: Set<string>;
} {
  const turn = getChatTurnOwnership().getSnapshot(scope).receipt?.state.current;
  const key = scopeKey(scope);
  let entry = reservations.get(key);
  if (!entry || (entry.turnId !== undefined && entry.turnId !== turn?.id)) {
    entry = { turnId: turn?.id, inputIds: new Set() };
    reservations.set(key, entry);
  }
  // Inputs reserved before the turn was known count against it.
  entry.turnId ??= turn?.id;
  return {
    taken: new Set([...(turn?.inputIds ?? []), ...Array.from(entry.inputIds)]),
    reserved: entry.inputIds,
  };
}

/** Reserve a slot for `inputId`; false when the current turn has none left. */
export function reserveTurnBindingSlot(
  scope: ChatTurnStateScope,
  inputId: string,
): boolean {
  const { taken, reserved } = currentSlots(scope);
  // A duplicate or retried id reuses its slot.
  if (!taken.has(inputId) && taken.size >= MAX_BOUND_INPUTS) return false;
  reserved.add(inputId);
  return true;
}

/**
 * A sent prompt counts toward its turn, which a Claude prompt binds only at
 * its result. Sent with no turn current, it opens a new pre-start window:
 * earlier reservations belong to dispatches that never started a turn.
 */
export function reservePromptBindingSlot(
  scope: ChatTurnStateScope,
  inputId: string,
): void {
  if (getChatTurnOwnership().getSnapshot(scope).receipt?.state.current)
    reserveTurnBindingSlot(scope, inputId);
  else
    reservations.set(scopeKey(scope), {
      turnId: undefined,
      inputIds: new Set([inputId]),
    });
}

/** Free an unused slot, only on a proven refusal or withdrawal. */
export function releaseTurnBindingSlot(
  scope: ChatTurnStateScope,
  inputId: string,
): void {
  reservations.get(scopeKey(scope))?.inputIds.delete(inputId);
}

/** Whether a new input would find no slot in the current turn. */
export function isCurrentTurnBindingFull(scope: ChatTurnStateScope): boolean {
  return currentSlots(scope).taken.size >= MAX_BOUND_INPUTS;
}

export function resetTurnBindingSlotsForTests(): void {
  reservations.clear();
}
