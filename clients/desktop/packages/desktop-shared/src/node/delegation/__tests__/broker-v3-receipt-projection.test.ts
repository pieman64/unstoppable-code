import { delegationReceiptAckToResult } from '../broker-settlement';
import type { DelegationReceiptAck } from '../receipt-reply';

describe('fitted acknowledgement public projection', () => {
  const snapshot = {
    delegationId: 'delegate',
    runGeneration: 2,
    resultIndex: 1,
    status: 'failed' as const,
    phase: 'idle' as const,
    usage: { inputTokens: 5 },
    stopReason: 'shutdown' as const,
    requestedModelId: 'model',
    partialText: 'partial',
    finalText: 'final',
    outputTruncated: false,
    cancelledByUser: false,
    control: {
      operationId: 'operation',
      operation: 'apply' as const,
      status: 'failed' as const,
      error: 'control error',
    },
    error: {
      code: 'apply_failed' as const,
      message: 'no changes',
      retryable: false,
    },
  };
  it('omits only the reduced apply counts, retaining every compatible field', () => {
    const ack: DelegationReceiptAck = {
      ok: true,
      outcome: 'completed',
      truncated: true,
      snapshot: {
        ...snapshot,
        control: { ...snapshot.control, applyFailure: { issueCount: 2 } },
        error: { ...snapshot.error, apply: { issueCount: 2 } },
      },
    };
    expect(delegationReceiptAckToResult(ack)).toEqual({
      ok: true,
      value: snapshot,
    });
  });
  it('keeps a snapshot without apply details field-for-field equal', () => {
    expect(
      delegationReceiptAckToResult({ ok: true, outcome: 'accepted', snapshot }),
    ).toEqual({ ok: true, value: snapshot });
  });
  it('omits apply details on a failed acknowledgement', () => {
    expect(
      delegationReceiptAckToResult({
        ok: false,
        error: { ...snapshot.error, apply: { issueCount: 3 } },
      }),
    ).toEqual({ ok: false, error: snapshot.error });
  });
});
