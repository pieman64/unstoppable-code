import type {
  AgentDelegationError,
  AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import {
  completeDelegationCommandReceipt,
  delegationReceiptEffectBytes,
  DELEGATION_RECEIPT_FINAL_RESERVATION_BYTES,
  fitDelegationReceiptAck,
  fitDelegationReceiptFinal,
  fitDelegationStopOutcomeReceipt,
  fitDelegationStopReceipt,
  projectDelegationCommandReplay,
  validateDelegationReceiptEntry,
  type DelegationReceiptError,
  type DelegationReceiptSnapshot,
  type DelegationReceiptDraft,
  type DelegationReceiptFitResult,
  type DelegationReceiptReplyV1,
} from '../receipt-reply';
import { canonicalDelegationJson } from '../settlement-identity';
import {
  type DelegationTranscriptReceiptEntry,
  DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
  DELEGATION_REGISTRY_MAX_ERROR_LENGTH,
} from '../transcript-port';

const operationId = 'abcdef12-3456-7890-abcd-1234567890ab';
const draft: DelegationReceiptDraft = {
  chatId: 'chat',
  delegationId: 'child',
  receiptKind: 'command',
  key: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
  operationId,
  runGeneration: 1,
  operation: 'apply',
  admittedAt: 123,
};
const snapshot: AgentDelegationSnapshot = {
  delegationId: 'child',
  status: 'running',
  outputTruncated: false,
  control: { operationId, operation: 'apply', status: 'accepted' },
};
const error: AgentDelegationError = {
  code: 'runtime_error',
  message: 'failed',
  retryable: true,
};
const receiptError: DelegationReceiptError = {
  code: 'runtime_error',
  message: 'failed',
  retryable: true,
};
function entry(
  result: DelegationReceiptFitResult,
): DelegationTranscriptReceiptEntry {
  if (!result.ok) throw new Error(result.reason);
  expect(result.ok).toBe(true);
  expect(validateDelegationReceiptEntry(result.entry).ok).toBe(true);
  expect(delegationReceiptEffectBytes(result.entry)).toBeLessThanOrEqual(
    DELEGATION_REGISTRY_MAX_ENTRY_BYTES,
  );
  return result.entry;
}
function command(): DelegationTranscriptReceiptEntry {
  const value = entry(
    fitDelegationReceiptAck(draft, { ok: true, outcome: 'accepted', snapshot }),
  );
  if (value.reply.kind !== 'command') throw new Error('Expected command');
  return value;
}
const stopDraft: DelegationReceiptDraft = {
  ...draft,
  receiptKind: 'stop',
  operation: 'stop',
};
const outcomeDraft: DelegationReceiptDraft = {
  ...stopDraft,
  receiptKind: 'stop_outcome',
  key: operationId,
  requestHash: null,
};

describe('receipt reply validation', () => {
  it('accepts every well-formed variant', () => {
    entry(
      fitDelegationReceiptAck(draft, {
        ok: true,
        outcome: 'accepted',
        snapshot,
      }),
    );
    entry(
      fitDelegationReceiptAck(draft, {
        ok: true,
        outcome: 'completed',
        snapshot,
      }),
    );
    entry(fitDelegationReceiptAck(draft, { ok: false, error }));
    entry(fitDelegationStopReceipt(stopDraft, 'accepted'));
    entry(
      fitDelegationStopOutcomeReceipt(outcomeDraft, {
        status: 'completed',
        finishedAt: 456,
      }),
    );
    entry(
      completeDelegationCommandReceipt(
        command(),
        fitDelegationReceiptFinal({ status: 'failed', error }),
      ),
    );
  });
  it.each([
    ['non-hex key', { key: 'g'.repeat(64) }],
    ['uppercase key', { key: 'A'.repeat(64) }],
    ['non-hex request hash', { requestHash: 'g'.repeat(64) }],
    ['uppercase request hash', { requestHash: 'B'.repeat(64) }],
    ['uppercase UUID', { operationId: operationId.toUpperCase() }],
    ['non-canonical UUID', { operationId: operationId.replaceAll('-', '') }],
    ['command stop operation', { operation: 'stop' }],
    [
      'reply kind mismatch',
      { reply: { kind: 'stop', ackStatus: 'accepted', runGeneration: 1 } },
    ],
  ])('rejects %s', (_name, change) => {
    expect(validateDelegationReceiptEntry({ ...command(), ...change }).ok).toBe(
      false,
    );
  });
  it('rejects a stop outcome not keyed by its operation id', () => {
    const value = entry(
      fitDelegationStopOutcomeReceipt(outcomeDraft, {
        status: 'completed',
        finishedAt: 456,
      }),
    );
    expect(
      validateDelegationReceiptEntry({ ...value, key: 'a'.repeat(64) }).ok,
    ).toBe(false);
  });
  it.each(['error', 'completed'])(
    'rejects final on a terminal %s acknowledgement',
    (kind) => {
      const value = entry(
        fitDelegationReceiptAck(
          draft,
          kind === 'error'
            ? { ok: false, error }
            : { ok: true, outcome: 'completed', snapshot },
        ),
      );
      expect(
        validateDelegationReceiptEntry({
          ...value,
          reply: { ...value.reply, final: { status: 'completed' } },
        }).ok,
      ).toBe(false);
    },
  );
});

describe('receipt reply totality at maxima', () => {
  const id = '\u0001'.repeat(256);
  const max = Number.MAX_SAFE_INTEGER;
  const message = '\u0001'.repeat(DELEGATION_REGISTRY_MAX_ERROR_LENGTH);
  // Including the surrounding quotes, this preview is exactly 4,096 JSON bytes.
  const preview = '"'.repeat(2047);
  const failure = {
    reason: 'conflict',
    issues: [],
    omittedIssues: max,
    guidance: message,
  } satisfies NonNullable<AgentDelegationError['apply']>;
  const bigError: AgentDelegationError = {
    code: 'apply_failed',
    message,
    retryable: true,
    apply: failure,
  };
  const bigDraft = {
    ...draft,
    chatId: id,
    delegationId: id,
    runGeneration: max,
    admittedAt: max,
  };
  const bigSnapshot: AgentDelegationSnapshot = {
    ...snapshot,
    delegationId: id,
    runGeneration: max,
    resultIndex: max,
    partialText: preview,
    finalText: preview,
    error: bigError,
    control: {
      operationId,
      operation: 'apply',
      status: 'failed',
      error: message,
      applyFailure: failure,
    },
    usage: {
      inputTokens: max,
      outputTokens: max,
      cachedInputTokens: max,
      cacheCreationInputTokens: max,
      costUsd: max,
    },
  };
  it.each(['accepted', 'completed'] as const)(
    'fits command success %s and retains immutable ack through every completion',
    (outcome) => {
      expect(Buffer.byteLength(JSON.stringify(preview))).toBe(4096);
      const value = entry(
        fitDelegationReceiptAck(bigDraft, {
          ok: true,
          outcome,
          snapshot: bigSnapshot,
        }),
      );
      if (value.reply.kind !== 'command') throw new Error('Expected command');
      expect(value.reply.ack.truncated).toBe(true);
      if (outcome !== 'accepted') return;
      const before = canonicalDelegationJson(value.reply.ack);
      for (const status of ['completed', 'failed'] as const) {
        const final = fitDelegationReceiptFinal({ status, error: bigError });
        expect(
          Buffer.byteLength(canonicalDelegationJson(final)),
        ).toBeLessThanOrEqual(DELEGATION_RECEIPT_FINAL_RESERVATION_BYTES);
        expect(final.error?.message.length).toBeLessThan(message.length);
        const completed = entry(completeDelegationCommandReceipt(value, final));
        if (completed.reply.kind !== 'command')
          throw new Error('Expected command');
        expect(canonicalDelegationJson(completed.reply.ack)).toBe(before);
      }
    },
  );
  it('fits command errors and marks shortening', () => {
    const value = entry(
      fitDelegationReceiptAck(bigDraft, { ok: false, error: bigError }),
    );
    if (value.reply.kind !== 'command') throw new Error('Expected command');
    expect(value.reply.ack.truncated).toBe(true);
  });
  it.each(['accepted', 'completed', 'failed'] as const)(
    'fits maximum stop %s',
    (status) => {
      entry(
        fitDelegationStopReceipt(
          { ...bigDraft, receiptKind: 'stop', operation: 'stop' },
          status,
        ),
      );
    },
  );
  it.each(['completed', 'failed'] as const)(
    'fits maximum stop outcome %s',
    (status) => {
      const value = entry(
        fitDelegationStopOutcomeReceipt(
          {
            ...bigDraft,
            receiptKind: 'stop_outcome',
            operation: 'stop',
            key: operationId,
            requestHash: null,
          },
          { status, finishedAt: max, error: bigError },
        ),
      );
      if (value.reply.kind !== 'stop_outcome')
        throw new Error('Expected outcome');
      expect(value.reply.error?.message.length).toBeLessThan(message.length);
    },
  );
  it('is deterministic and never mutates valid inputs or malformed drafts', () => {
    const before = canonicalDelegationJson({ bigDraft, bigSnapshot, bigError });
    expect(
      fitDelegationReceiptAck(bigDraft, {
        ok: true,
        outcome: 'accepted',
        snapshot: bigSnapshot,
      }),
    ).toEqual(
      fitDelegationReceiptAck(bigDraft, {
        ok: true,
        outcome: 'accepted',
        snapshot: bigSnapshot,
      }),
    );
    expect(
      fitDelegationReceiptFinal({ status: 'failed', error: bigError }),
    ).toEqual(fitDelegationReceiptFinal({ status: 'failed', error: bigError }));
    expect(fitDelegationStopReceipt(stopDraft, 'accepted')).toEqual(
      fitDelegationStopReceipt(stopDraft, 'accepted'),
    );
    expect(
      fitDelegationStopOutcomeReceipt(outcomeDraft, {
        status: 'failed',
        finishedAt: max,
        error: bigError,
      }),
    ).toEqual(
      fitDelegationStopOutcomeReceipt(outcomeDraft, {
        status: 'failed',
        finishedAt: max,
        error: bigError,
      }),
    );
    expect(canonicalDelegationJson({ bigDraft, bigSnapshot, bigError })).toBe(
      before,
    );
    const malformed = { ...draft, key: 'INVALID' };
    const original = canonicalDelegationJson(malformed);
    expect(fitDelegationReceiptAck(malformed, { ok: false, error }).ok).toBe(
      false,
    );
    expect(
      fitDelegationStopReceipt(
        { ...malformed, receiptKind: 'stop', operation: 'stop' },
        'accepted',
      ).ok,
    ).toBe(false);
    expect(
      fitDelegationStopOutcomeReceipt(
        { ...outcomeDraft, operationId: 'INVALID' },
        { status: 'failed', finishedAt: max },
      ).ok,
    ).toBe(false);
    expect(canonicalDelegationJson(malformed)).toBe(original);
  });
});

describe('projectDelegationCommandReplay B2', () => {
  const acknowledged: DelegationReceiptSnapshot = {
    delegationId: 'child',
    status: 'running',
    outputTruncated: false,
    control: { operationId, operation: 'apply', status: 'accepted' },
  };
  const accepted: Extract<DelegationReceiptReplyV1, { kind: 'command' }> = {
    kind: 'command',
    ack: {
      ok: true,
      outcome: 'accepted',
      snapshot: acknowledged,
      truncated: true,
    },
    final: null,
  };
  it.each(['user', 'agent'] as const)(
    'replays terminal acknowledgements as the complete first ack for %s',
    (caller) => {
      const terminalError = {
        ok: false,
        error: { ...receiptError, apply: { issueCount: 2 } },
        truncated: true,
      } as const;
      expect(
        canonicalDelegationJson(
          projectDelegationCommandReplay(
            { ...accepted, ack: terminalError },
            caller,
          ),
        ),
      ).toBe(canonicalDelegationJson(terminalError));
      const completed = {
        ok: true,
        outcome: 'completed',
        snapshot: acknowledged,
      } as const;
      expect(
        canonicalDelegationJson(
          projectDelegationCommandReplay(
            { ...accepted, ack: completed },
            caller,
          ),
        ),
      ).toBe(canonicalDelegationJson(completed));
    },
  );
  it.each([
    null,
    { status: 'completed' },
    { status: 'failed', error: receiptError },
  ] as const)(
    'replays an accepted user acknowledgement unchanged with final %j',
    (final) => {
      expect(
        canonicalDelegationJson(
          projectDelegationCommandReplay({ ...accepted, final }, 'user'),
        ),
      ).toBe(canonicalDelegationJson(accepted.ack));
    },
  );
  it('replays an unresolved agent acknowledgement unchanged', () => {
    expect(
      canonicalDelegationJson(
        projectDelegationCommandReplay(accepted, 'agent'),
      ),
    ).toBe(canonicalDelegationJson(accepted.ack));
  });
  it('projects completed control onto a copy of the acknowledgement', () => {
    const before = canonicalDelegationJson(accepted);
    expect(
      projectDelegationCommandReplay(
        { ...accepted, final: { status: 'completed' } },
        'agent',
      ),
    ).toEqual({
      ...accepted.ack,
      snapshot: {
        ...acknowledged,
        control: { ...acknowledged.control, status: 'completed' },
      },
    });
    expect(canonicalDelegationJson(accepted)).toBe(before);
  });
  it('returns apply_failed without apply details', () => {
    expect(
      projectDelegationCommandReplay(
        {
          ...accepted,
          final: {
            status: 'failed',
            error: {
              code: 'apply_failed',
              message: 'apply failed',
              retryable: false,
              apply: { issueCount: 2 },
            },
          },
        },
        'agent',
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'apply_failed',
        message: 'apply failed',
        retryable: false,
      },
    });
  });
  it('projects other failures onto control', () => {
    expect(
      projectDelegationCommandReplay(
        { ...accepted, final: { status: 'failed', error: receiptError } },
        'agent',
      ),
    ).toEqual({
      ...accepted.ack,
      snapshot: {
        ...acknowledged,
        control: {
          ...acknowledged.control,
          status: 'failed',
          error: error.message,
        },
      },
    });
  });
  it('returns a minimal snapshot without inventing control', () => {
    const minimal = {
      delegationId: 'child',
      status: 'running',
      outputTruncated: true,
    } satisfies AgentDelegationSnapshot;
    const ack = { ok: true, outcome: 'accepted', snapshot: minimal } as const;
    expect(
      projectDelegationCommandReplay(
        { ...accepted, ack, final: { status: 'completed' } },
        'agent',
      ),
    ).toEqual(ack);
  });
  it('handles final.error absent', () => {
    expect(
      projectDelegationCommandReplay(
        { ...accepted, final: { status: 'failed' } },
        'agent',
      ),
    ).toEqual({
      ...accepted.ack,
      snapshot: {
        ...acknowledged,
        control: { ...acknowledged.control, status: 'failed' },
      },
    });
  });
});

describe('receipt reply 11b whitelist and saturation', () => {
  it('retains a small requestedModelId and bounds a long one', () => {
    const small = command(); // baseline without the field
    expect(small.reply.kind).toBe('command');
    const withModel = entry(
      fitDelegationReceiptAck(draft, {
        ok: true,
        outcome: 'accepted',
        snapshot: { ...snapshot, requestedModelId: 'model-123' },
      }),
    );
    expect(
      withModel.reply.kind === 'command' && withModel.reply.ack.ok
        ? withModel.reply.ack.snapshot.requestedModelId
        : undefined,
    ).toBe('model-123');
    const long = entry(
      fitDelegationReceiptAck(draft, {
        ok: true,
        outcome: 'accepted',
        snapshot: { ...snapshot, requestedModelId: '\u0001'.repeat(300) },
      }),
    );
    if (long.reply.kind !== 'command' || !long.reply.ack.ok)
      throw new Error('Expected a command acknowledgement');
    expect(long.reply.ack.snapshot.requestedModelId?.length).toBe(256);
    expect(long.reply.ack.truncated).toBe(true);
    expect(long.reply.ack.snapshot.outputTruncated).toBe(true);
  });

  it('saturates issue counts at the largest safe integer everywhere', () => {
    const apply: NonNullable<AgentDelegationError['apply']> = {
      reason: 'conflict',
      issues: [{ path: 'a', reason: 'parent_changed' }],
      omittedIssues: Number.MAX_SAFE_INTEGER,
      guidance: 'retry',
    };
    const failing: AgentDelegationError = {
      code: 'apply_failed',
      message: 'apply failed',
      retryable: false,
      apply,
    };
    const asError = entry(
      fitDelegationReceiptAck(draft, { ok: false, error: failing }),
    );
    expect(
      asError.reply.kind === 'command' && !asError.reply.ack.ok
        ? asError.reply.ack.error.apply?.issueCount
        : undefined,
    ).toBe(Number.MAX_SAFE_INTEGER);
    const asSnapshot = entry(
      fitDelegationReceiptAck(draft, {
        ok: true,
        outcome: 'accepted',
        snapshot: {
          ...snapshot,
          error: failing,
          control: {
            operationId,
            operation: 'apply',
            status: 'failed',
            applyFailure: apply,
          },
        },
      }),
    );
    if (asSnapshot.reply.kind !== 'command' || !asSnapshot.reply.ack.ok)
      throw new Error('Expected a command acknowledgement');
    expect(
      asSnapshot.reply.ack.snapshot.control?.applyFailure?.issueCount,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(
      fitDelegationReceiptFinal({ status: 'failed', error: failing }).error
        ?.apply?.issueCount,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});
