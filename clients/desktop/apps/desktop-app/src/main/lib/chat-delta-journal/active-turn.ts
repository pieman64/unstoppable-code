/**
 * The in-progress turn of a delta-journal scope (phase 10): while a chat's
 * active rows change only through journal records, they live in the
 * writer's memory and in those records, never in a rewritten
 * `<chat>.active.json`.
 *
 * - **Checkpoint policy.** A checkpoint during the turn would have to write
 *   the turn's whole active rows to the sidecar, an O(turn) rewrite. The
 *   idle trigger therefore waits for the turn to end, and the size trigger
 *   lets the journal grow to {@link ACTIVE_TURN_JOURNAL_FACTOR} times the
 *   journaled active rows (and never below the size threshold) before a
 *   checkpoint writes them once. Those rewrites then cost at most
 *   1/{@link ACTIVE_TURN_JOURNAL_FACTOR} of the journal bytes written,
 *   whatever the turn's length, and the journal stays within a constant
 *   factor of the turn's own size.
 * - **Search.** {@link activeTurnDelta} answers "which active rows changed
 *   since transcript revision R" from the records in memory, so chat search
 *   updates in-flight text from the changed rows instead of re-reading the
 *   turn or replaying the journal.
 */
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { isActiveEffect } from './format';
import { primaryEffects, type JournalCommit } from './replay';

/**
 * During a turn, the journal may hold this many times the journaled active
 * rows' bytes before the size trigger checkpoints them.
 */
export const ACTIVE_TURN_JOURNAL_FACTOR = 8;

const rowBytes = new WeakMap<PersistedChatMessage, number>();

/**
 * A row's serialized UTF-8 size, cached per row object: an upsert replaces
 * only the rows it changes, so a turn's other rows keep their cached size.
 */
export function activeRowBytes(message: PersistedChatMessage): number {
  let bytes = rowBytes.get(message);
  if (bytes === undefined) {
    bytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    rowBytes.set(message, bytes);
  }
  return bytes;
}

/**
 * Whether the size trigger checkpoints now. `activeBytes` is the size of
 * the active rows the journal holds ahead of the files; 0 when no turn is
 * journaled, which leaves the phase 09 threshold unchanged.
 */
export function journalCheckpointDue(
  journalBytes: number,
  thresholdBytes: number,
  activeBytes: number,
): boolean {
  return (
    journalBytes >=
    Math.max(thresholdBytes, ACTIVE_TURN_JOURNAL_FACTOR * activeBytes)
  );
}

/** What changed in a chat's in-progress turn since a transcript revision. */
export interface ActiveTurnDelta {
  /** The revision this delta brings a reader to. */
  transcriptRevision: number;
  /** Ids of the active rows now, in order. */
  order: string[];
  /** The rows changed since the requested revision that are still active. */
  changed: PersistedChatMessage[];
}

/**
 * The active rows a chat's records changed after `since`, when only
 * revisioned active upserts did. `baseRevision` is the chat's revision in
 * the files the records apply to; `current` is the overlay's active state.
 * Undefined when the change is not a run of upserts (a full active write, a
 * committed-row change, a chat created) or does not reach back to `since`:
 * the reader then reads the active rows whole. Walks the records from the
 * newest, so a reader that keeps up touches only the records it missed.
 */
export function activeTurnDelta(
  records: readonly JournalCommit[],
  chatId: string,
  since: number,
  current: {
    messages: readonly PersistedChatMessage[];
    transcriptRevision: number;
  },
  baseRevision: number,
): ActiveTurnDelta | undefined {
  if (!Number.isSafeInteger(since) || since > current.transcriptRevision)
    return undefined;
  const changed = new Set<string>();
  let reached = since === current.transcriptRevision;
  for (let index = records.length - 1; index >= 0 && !reached; index -= 1) {
    const record = records[index];
    const effects = primaryEffects(record);
    for (let at = effects.length - 1; at >= 0; at -= 1) {
      const effect = effects[at];
      if (effect.chatId !== chatId) continue;
      if (!isActiveEffect(effect) || effect.transcriptRevision === undefined)
        return undefined;
      if (effect.transcriptRevision <= since) {
        if (effect.transcriptRevision !== since) return undefined;
        reached = true;
        break;
      }
      if (effect.kind !== 'active-upsert') return undefined;
      for (const message of effect.messages) changed.add(message.id);
    }
  }
  if (!reached && since !== baseRevision) return undefined;
  return {
    transcriptRevision: current.transcriptRevision,
    order: current.messages.map((message) => message.id),
    changed: structuredClone(
      current.messages.filter((message) => changed.has(message.id)),
    ),
  };
}
