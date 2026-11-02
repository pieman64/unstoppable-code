import {
  locatorFromSettlement,
  v3SettlementRequest,
  type V3SettlementContractHelper,
  type V3SettlementContractInput,
  type V3SettlementContractResult,
} from './broker-settlement-contract';
import {
  canonicalDelegationJson,
  delegationTranscriptSettlementDigest,
} from './settlement-identity';
import type { DelegationTranscriptResultEntry } from './transcript-port';
import type {
  AgentDelegationResult,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import type { DelegationReceiptAck } from './receipt-reply';

/**
 * Project B2's fitted acknowledgement to the public broker reply. Receipt-only
 * apply diagnostic counts are intentionally omitted, never fabricated into
 * full apply details. No optional execution field is invented.
 */
export function delegationReceiptAckToResult(
  ack: DelegationReceiptAck,
): AgentDelegationResult<AgentDelegationSnapshot> {
  if (!ack.ok)
    return {
      ok: false,
      error: {
        code: ack.error.code,
        message: ack.error.message,
        retryable: ack.error.retryable,
      },
    };
  const value = ack.snapshot;
  return {
    ok: true,
    value: {
      delegationId: value.delegationId,
      status: value.status,
      outputTruncated: value.outputTruncated,
      ...(value.runGeneration === undefined
        ? {}
        : { runGeneration: value.runGeneration }),
      ...(value.resultIndex === undefined
        ? {}
        : { resultIndex: value.resultIndex }),
      ...(value.phase === undefined ? {} : { phase: value.phase }),
      ...(value.usage === undefined ? {} : { usage: value.usage }),
      ...(value.stopReason === undefined
        ? {}
        : { stopReason: value.stopReason }),
      ...(value.stoppedBy === undefined ? {} : { stoppedBy: value.stoppedBy }),
      ...(value.cancelledByUser === undefined
        ? {}
        : { cancelledByUser: value.cancelledByUser }),
      ...(value.requestedModelId === undefined
        ? {}
        : { requestedModelId: value.requestedModelId }),
      ...(value.partialText === undefined
        ? {}
        : { partialText: value.partialText }),
      ...(value.finalText === undefined ? {} : { finalText: value.finalText }),
      ...(value.control === undefined
        ? {}
        : {
            control: {
              operationId: value.control.operationId,
              operation: value.control.operation,
              status: value.control.status,
              ...(value.control.error === undefined
                ? {}
                : { error: value.control.error }),
            },
          }),
      ...(value.error === undefined
        ? {}
        : {
            error: {
              code: value.error.code,
              message: value.error.message,
              retryable: value.error.retryable,
            },
          }),
    },
  };
}

/** C3 adoption validates logical identity, never an answer body. */
function matchesIntent(
  input: V3SettlementContractInput,
  result: DelegationTranscriptResultEntry,
): boolean {
  return (
    result.settlementKey === input.intent.settlementKey &&
    result.runGeneration === input.target.runGeneration &&
    result.runGeneration === input.intent.runGeneration &&
    result.resultIndex === input.intent.assertedResultIndex &&
    result.settlementDigest === input.intent.expectedSettlementDigest &&
    canonicalDelegationJson(result.outcome) ===
      canonicalDelegationJson(input.intent.outcome)
  );
}

/**
 * One terminal consistency boundary. An existing intent is supplied unchanged
 * by the broker, including on retry. Registry uncertainty is never absence.
 */
export const settleV3Generation: V3SettlementContractHelper = async (
  input,
  dependencies,
) => {
  let stage: Extract<V3SettlementContractResult, { kind: 'retry' }>['stage'] =
    'intent';
  try {
    const request = v3SettlementRequest(input);
    if (
      input.target.runGeneration !== input.registration.runGeneration ||
      input.target.chatId !== input.registration.chatId ||
      input.target.delegationId !== input.registration.delegationId ||
      input.registration.store !== 'stream' ||
      delegationTranscriptSettlementDigest(request) !==
        input.intent.expectedSettlementDigest
    )
      return {
        kind: 'conflict',
        reason: 'Settlement intent identity mismatch',
      };

    await dependencies.commitIntent(input.intent);
    stage = 'lookup';
    let lookup = await dependencies.resultBySettlementKey({
      chatId: input.target.chatId,
      delegationId: input.target.delegationId,
      settlementKey: input.intent.settlementKey,
    });
    if (!lookup.ok && lookup.error.code === 'not_found')
      lookup = await dependencies.resultByGeneration({
        chatId: input.target.chatId,
        delegationId: input.target.delegationId,
        runGeneration: input.target.runGeneration,
      });
    if (!lookup.ok && lookup.error.code !== 'not_found')
      return { kind: 'retry', stage, error: lookup.error };

    let result: DelegationTranscriptResultEntry;
    let kind: 'settled' | 'adopted';
    if (lookup.ok) {
      if (!matchesIntent(input, lookup.value))
        return {
          kind: 'conflict',
          reason: 'Canonical result conflicts with intent',
        };
      result = lookup.value;
      kind = 'adopted';
    } else {
      stage = 'open';
      const opened = await dependencies.ensureRegisteredAndOpen(
        input.registration,
        input.target,
      );
      if (!opened.ok) return { kind: 'retry', stage, error: opened.error };
      stage = 'settle';
      const settled = await dependencies.settle(request);
      if (!settled.ok) {
        if (
          settled.error.code === 'conflict' ||
          settled.error.code === 'stale_identity'
        )
          return { kind: 'conflict', reason: settled.error.message };
        return { kind: 'retry', stage, error: settled.error };
      }
      if (!matchesIntent(input, settled.value.result))
        return {
          kind: 'conflict',
          reason: 'Settlement returned a different identity',
        };
      result = settled.value.result;
      kind = 'settled';
    }
    const locator = locatorFromSettlement({
      result,
      settlement: {
        target: input.target,
        settlementKey: result.settlementKey,
        streamRevision: result.settlement.streamRevision,
        contentRevision: result.settlement.contentRevision,
        finalItemCount: result.settlement.finalItemCount,
        replayed: kind === 'adopted',
      },
    });
    stage = 'card';
    await dependencies.reconcileCardPublication?.();
    stage = 'locator';
    await dependencies.commitLocator(locator);
    stage = 'notify';
    await dependencies.notify(locator);
    try {
      await dependencies.markNotified(locator);
    } catch {
      // The locator is durable. A missed marker only re-notifies the host's
      // idempotent generation-keyed upsert after restart.
    }
    return { kind, result, locator };
  } catch {
    // Dependencies own durable writes; do not roll back an intent after any
    // effect, or reinterpret the terminal outcome as an interruption.
    return { kind: 'retry', stage };
  }
};
