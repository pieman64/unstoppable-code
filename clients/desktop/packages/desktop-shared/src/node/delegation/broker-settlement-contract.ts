import type { CardStateDraft } from '@canopy/protocol/canopy-core';
import { createHash } from 'node:crypto';
import type {
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptResultEntry,
  DelegationTranscriptSettleAnswer,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptSettleResult,
  DelegationTranscriptStreamState,
  DelegationTranscriptTarget,
} from './transcript-port';
import type {
  StoredDelegationV3Answer,
  StoredDelegationV3ResultLocator,
  StoredDelegationV3Settling,
} from './record-v3';

export const STORED_DELEGATION_V3_PREVIEW_LIMIT = 4096;

/**
 * The existing terminal event is the handoff: capture its exact optional
 * finalText before lifecycle state takes its bounded preview. D6 never uses
 * progress partialText here.
 */
export function captureSettlementAnswer(finalText: string | undefined): {
  readonly answer: StoredDelegationV3Answer;
  readonly settleAnswer: DelegationTranscriptSettleAnswer;
} {
  if (finalText === undefined) return { answer: 'none', settleAnswer: null };
  if (finalText.length === 0) {
    return {
      answer: { role: 'final', empty: true },
      settleAnswer: { role: 'final', text: '' },
    };
  }
  const sha256 = createHash('sha256')
    .update(Buffer.from(finalText, 'utf16le'))
    .digest('hex');
  return {
    answer: { role: 'final', sha256, length: finalText.length },
    settleAnswer: { role: 'final', text: finalText },
  };
}

/** Clip a persisted execution preview without splitting a surrogate pair. */
export function v3StatePreview(text: string): string {
  if (text.length <= STORED_DELEGATION_V3_PREVIEW_LIMIT) return text;
  const boundary = STORED_DELEGATION_V3_PREVIEW_LIMIT;
  const finalCodeUnit = text.charCodeAt(boundary - 1);
  const nextCodeUnit = text.charCodeAt(boundary);
  const end =
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
      ? boundary - 1
      : boundary;
  return text.slice(0, end);
}

/** C3 input: the exact terminal identity, answer and persisted intent. */
export interface V3SettlementContractInput {
  readonly cardDraft?: CardStateDraft;
  readonly cardRevision?: number;
  readonly target: DelegationTranscriptTarget;
  readonly registration: DelegationTranscriptGenerationRegistration;
  readonly intent: StoredDelegationV3Settling;
  /** Exact terminal answer; never a lifecycle preview. */
  readonly settleAnswer: DelegationTranscriptSettleAnswer;
}

/** Dependencies are the only effects owned by the C3 terminal helper. */
export interface V3SettlementContractDependencies {
  /** Step 1: commit intent before any registry mutation. */
  commitIntent(intent: StoredDelegationV3Settling): Promise<void>;
  /** Step 2: idempotently register, then ensure the descriptor is open. */
  ensureRegisteredAndOpen(
    registration: DelegationTranscriptGenerationRegistration,
    target: DelegationTranscriptTarget,
  ): Promise<
    | { readonly ok: true; readonly value: DelegationTranscriptStreamState }
    | { readonly ok: false; readonly error: DelegationTranscriptPortError }
  >;
  /** Step 3: every settle uses `finalChanges: []` and `openRows: 'finalize'`. */
  settle(
    request: DelegationTranscriptSettleRequest,
  ): ReturnType<DelegationTranscriptPort['settle']>;
  /** C3's first repair lookup, by deterministic settlement key. */
  resultBySettlementKey(
    input: Parameters<DelegationTranscriptPort['resultBySettlementKey']>[0],
  ): ReturnType<DelegationTranscriptPort['resultBySettlementKey']>;
  /** C3's fallback repair lookup, by generation. */
  resultByGeneration(
    input: Parameters<DelegationTranscriptPort['resultByGeneration']>[0],
  ): ReturnType<DelegationTranscriptPort['resultByGeneration']>;
  /** Step 4: commit body-free locator, activity and clear intent atomically. */
  commitLocator(locator: StoredDelegationV3ResultLocator): Promise<void>;
  /** Descriptor reconciliation after first settle, keyed replay or adoption, before locator admission. */
  reconcileCardPublication?(): Promise<void>;
  /** Step 5: notify only after the locator is durable. */
  notify(locator: StoredDelegationV3ResultLocator): Promise<void>;
  /**
   * Step 6: commit `notified: true` on the same locator. A failure is not a
   * retry stage; restart re-notifies once, which the host treats as an upsert.
   */
  markNotified(locator: StoredDelegationV3ResultLocator): Promise<void>;
}

export type V3SettlementContractResult =
  | {
      readonly kind: 'settled';
      readonly result: DelegationTranscriptResultEntry;
      readonly locator: StoredDelegationV3ResultLocator;
    }
  | {
      readonly kind: 'adopted';
      readonly result: DelegationTranscriptResultEntry;
      readonly locator: StoredDelegationV3ResultLocator;
    }
  | {
      /**
       * What is durable depends on the stage. `intent`: nothing was
       * committed. `registration` through `locator`: the original intent
       * remains, and a retry never replaces its outcome. `notify`: the locator
       * is durable and the intent cleared, so a retry only re-notifies from it.
       */
      readonly kind: 'retry';
      readonly stage:
        | 'intent'
        | 'registration'
        | 'open'
        | 'settle'
        | 'lookup'
        | 'locator'
        | 'card'
        | 'notify';
      readonly error?: DelegationTranscriptPortError;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: string;
    };

export type V3SettlementContractHelper = (
  input: V3SettlementContractInput,
  dependencies: V3SettlementContractDependencies,
) => Promise<V3SettlementContractResult>;

/** Stable D4 request shape used for the helper's exact final answer. */
export function v3SettlementRequest(
  input: V3SettlementContractInput,
): DelegationTranscriptSettleRequest {
  return {
    ...(input.cardDraft === undefined
      ? {}
      : { cardDraft: input.cardDraft, cardRevision: input.cardRevision }),
    target: input.target,
    settlementKey: input.intent.settlementKey,
    resultIndex: input.intent.assertedResultIndex,
    outcome: input.intent.outcome,
    finalChanges: [],
    answer: input.settleAnswer,
    openRows: 'finalize',
  };
}

/** D4 notification locator uses no result body or transcript read. */
export function locatorFromSettlement(
  result: DelegationTranscriptSettleResult,
): StoredDelegationV3ResultLocator {
  return {
    resultIndex: result.result.resultIndex,
    runGeneration: result.result.runGeneration,
    status: result.result.outcome.status,
    settledAt: result.result.outcome.finishedAt,
    ...(result.result.outcome.stopReason !== undefined
      ? { stopReason: result.result.outcome.stopReason }
      : {}),
  };
}
