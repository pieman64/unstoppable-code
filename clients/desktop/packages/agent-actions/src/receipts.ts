import type { AgentActionCall } from './surface/family';
import type { AgentActionToolResult } from './tools/definition';

export interface AgentActionReceiptAttempt {
  idempotencyKey: string;
  /**
   * SHA-256 of the canonical request the key covers. A key held with another
   * fingerprint is a conflict, never a replay.
   */
  fingerprint: string;
  /** One run of `runIdempotentWrite`; unique across processes. */
  attemptId: string;
}

export interface AgentActionReceiptRecord extends AgentActionReceiptAttempt {
  /** The complete tool result the original call returned. */
  result: AgentActionToolResult;
}

/**
 * What an attempt found for its key: the committed result to return, a
 * claim this attempt now owns and may write under, or another attempt's
 * claim still in flight, under which it must not write. A claim on an
 * uncertain key (`uncertain: true`) tells the attempt that an earlier
 * attempt's write may have happened.
 */
export type AgentActionReceiptClaim =
  | { status: 'committed'; result: AgentActionToolResult }
  | { status: 'claimed'; uncertain: boolean }
  | { status: 'in_progress' }
  | { status: 'conflict' };

/**
 * The committed results of idempotent writes, and the single-flight claim
 * that keeps one attempt per key writing at a time. A retried call returns
 * the recorded result unchanged, including inline watcher outcomes and
 * `delivery`, without running anything again.
 *
 * - `claim` atomically reports `conflict` when the key's recorded result,
 *   live claim, or uncertain mark carries another fingerprint, otherwise
 *   returns the recorded result, or claims the key for the attempt when no
 *   other attempt holds it (`uncertain` reports whether the key is
 *   uncertain), or reports `in_progress` while another attempt's claim is
 *   held.
 * - `record` stores the result with its fingerprint and ends the claim. The
 *   first recorded result for a key is kept; a later record leaves it
 *   unchanged. A recorded result replaces the key's uncertain mark.
 * - `abandon` ends the claim of an attempt whose write definitely did not
 *   happen, only when that attempt owns it. It never clears an uncertain
 *   mark: the earlier write may still have happened.
 * - `markUncertain` is for an attempt whose write may have happened (its
 *   outcome is unknown). It marks the key uncertain with the attempt's
 *   fingerprint, and ends the attempt's claim when that attempt owns it. An
 *   uncertain key is sticky until a result is recorded: only an attempt with
 *   the same fingerprint may claim it again, and any other request under the
 *   key is a `conflict`. Marking a key that already has a recorded result
 *   changes nothing.
 *
 * A store shared by several processes must expire a claim whose attempt
 * stopped without recording or abandoning (a lease longer than any write),
 * so a crashed attempt does not block its key; an expired claim leaves the
 * key's fingerprint as an uncertain mark, since that attempt may have
 * written. A store keeps an uncertain mark at least as long as it keeps
 * recorded results. Idempotency keys name their
 * calling workspace, chat, and actor; a store must still scope what it
 * holds to the trusted calling workspace and chat (`call.scope`) and actor
 * (`call.actorKey`, or the host's user), and never answer one chat or actor
 * with another's result.
 */
export interface AgentActionReceiptStore<H> {
  claim(
    input: AgentActionReceiptAttempt,
    call: AgentActionCall<H>,
  ): Promise<AgentActionReceiptClaim>;
  record(
    input: AgentActionReceiptRecord,
    call: AgentActionCall<H>,
  ): Promise<void>;
  abandon(
    input: AgentActionReceiptAttempt,
    call: AgentActionCall<H>,
  ): Promise<void>;
  markUncertain(
    input: AgentActionReceiptAttempt,
    call: AgentActionCall<H>,
  ): Promise<void>;
}

const DEFAULT_MAX_RECEIPTS = 1000;

/**
 * Process-local receipts for a single host process, scoped by calling
 * workspace, chat, actor, and idempotency key, with each request's
 * fingerprint. Claims last until their attempt records, abandons, or marks
 * its key uncertain. The oldest results and uncertain marks are each
 * dropped past `maxEntries`, after which a retry runs as a new write.
 */
export function createInMemoryAgentActionReceipts<H>(
  options: { maxEntries?: number } = {},
): AgentActionReceiptStore<H> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_RECEIPTS;
  const results = new Map<
    string,
    { result: AgentActionToolResult; fingerprint: string }
  >();
  const claims = new Map<string, { attemptId: string; fingerprint: string }>();
  const uncertain = new Map<string, string>();
  const keep = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.set(key, value);
    if (map.size > maxEntries) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
  };
  const keyOf = (idempotencyKey: string, call: AgentActionCall<H>): string =>
    JSON.stringify([
      call.scope?.workspaceId ?? null,
      call.scope?.chatId ?? null,
      call.actorKey ?? null,
      idempotencyKey,
    ]);
  return {
    claim: (input, call): Promise<AgentActionReceiptClaim> => {
      const key = keyOf(input.idempotencyKey, call);
      const recorded = results.get(key);
      const held = recorded ?? claims.get(key);
      const uncertainFingerprint = uncertain.get(key);
      if (
        (held && held.fingerprint !== input.fingerprint) ||
        (uncertainFingerprint !== undefined &&
          uncertainFingerprint !== input.fingerprint)
      ) {
        return Promise.resolve({ status: 'conflict' });
      }
      if (recorded) {
        return Promise.resolve({
          status: 'committed',
          result: recorded.result,
        });
      }
      if (held) return Promise.resolve({ status: 'in_progress' });
      claims.set(key, {
        attemptId: input.attemptId,
        fingerprint: input.fingerprint,
      });
      return Promise.resolve({
        status: 'claimed',
        uncertain: uncertainFingerprint !== undefined,
      });
    },
    record: (input, call): Promise<void> => {
      const key = keyOf(input.idempotencyKey, call);
      claims.delete(key);
      uncertain.delete(key);
      if (results.has(key)) return Promise.resolve();
      keep(results, key, {
        result: { ...input.result },
        fingerprint: input.fingerprint,
      });
      return Promise.resolve();
    },
    abandon: (input, call): Promise<void> => {
      const key = keyOf(input.idempotencyKey, call);
      if (claims.get(key)?.attemptId === input.attemptId) claims.delete(key);
      return Promise.resolve();
    },
    markUncertain: (input, call): Promise<void> => {
      const key = keyOf(input.idempotencyKey, call);
      if (claims.get(key)?.attemptId === input.attemptId) claims.delete(key);
      if (!results.has(key)) keep(uncertain, key, input.fingerprint);
      return Promise.resolve();
    },
  };
}
