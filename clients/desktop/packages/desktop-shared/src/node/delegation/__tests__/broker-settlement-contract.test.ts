import {
  captureSettlementAnswer,
  STORED_DELEGATION_V3_PREVIEW_LIMIT,
  v3SettlementRequest,
  v3StatePreview,
} from '../broker-settlement-contract';
import type {
  V3SettlementContractInput,
  V3SettlementContractResult,
} from '../broker-settlement-contract';
import { delegationSettlementKey } from '../record-v3';
import type { StoredDelegationV3Settling } from '../record-v3';

const CHAT_ID = 'chat-1';
const DELEGATION_ID = '00000000-0000-4000-8000-000000000003';
const RUN_GENERATION = 7;

describe('v3 broker settlement contract', () => {
  it('captures the exact terminal text before making a bounded state preview', () => {
    const finalText = 'x'.repeat(65_537);
    const captured = captureSettlementAnswer(finalText);
    const statePreview = v3StatePreview(finalText);

    expect(captured.answer).toEqual({
      role: 'final',
      sha256:
        'f92af5129bd158beb7bdecbb381276688aecbf918b47346d1fd338964b5b91e5',
      length: 65_537,
    });
    expect(captured.settleAnswer).toEqual({ role: 'final', text: finalText });
    expect(statePreview).toBe('x'.repeat(STORED_DELEGATION_V3_PREVIEW_LIMIT));
    expect(statePreview).toHaveLength(STORED_DELEGATION_V3_PREVIEW_LIMIT);
    expect(statePreview).not.toBe(finalText);
    expect(captured.answer).not.toHaveProperty('text');
    const previewState = { finalText: statePreview };
    expect(previewState.finalText).not.toBe(finalText);
  });

  it('distinguishes no final answer from an explicitly empty final answer', () => {
    expect(captureSettlementAnswer(undefined)).toEqual({
      answer: 'none',
      settleAnswer: null,
    });
    expect(captureSettlementAnswer('')).toEqual({
      answer: { role: 'final', empty: true },
      settleAnswer: { role: 'final', text: '' },
    });
  });

  it.each([
    [
      'astral text',
      '🌿',
      'c646f3c3773cde0f9890c742b6404edb56686785678b3a13edfb13889d197d12',
      2,
    ],
    [
      'a lone surrogate',
      '\uD800',
      '205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750',
      1,
    ],
  ])(
    'keeps %s identity in exact final text',
    (_label, text, sha256, length) => {
      const captured = captureSettlementAnswer(text);

      expect(captured.answer).toEqual({ role: 'final', sha256, length });
      expect(captured.settleAnswer).toEqual({ role: 'final', text });
    },
  );

  it('clips only across a real surrogate pair at the UTF-16 boundary', () => {
    const clippedPair = v3StatePreview(`${'x'.repeat(4095)}🌿`);
    const retainedPair = v3StatePreview(`${'x'.repeat(4094)}🌿y`);
    const retainedLoneSurrogate = v3StatePreview(`${'x'.repeat(4095)}\uD800z`);

    expect(clippedPair).toHaveLength(STORED_DELEGATION_V3_PREVIEW_LIMIT - 1);
    expect(retainedPair).toHaveLength(STORED_DELEGATION_V3_PREVIEW_LIMIT);
    expect(retainedPair.charCodeAt(4094)).toBe(0xd83c);
    expect(retainedPair.charCodeAt(4095)).toBe(0xdf3f);
    expect(retainedLoneSurrogate).toHaveLength(
      STORED_DELEGATION_V3_PREVIEW_LIMIT,
    );
    expect(retainedLoneSurrogate.charCodeAt(4095)).toBe(0xd800);
  });

  it('freezes the exact D4 settle request shape and retry outcome type', () => {
    const finalText = 'exact final answer';
    const captured = captureSettlementAnswer(finalText);
    const intent: StoredDelegationV3Settling = {
      runGeneration: RUN_GENERATION,
      settlementKey: delegationSettlementKey(
        CHAT_ID,
        DELEGATION_ID,
        RUN_GENERATION,
      ),
      assertedResultIndex: 1,
      outcome: { status: 'completed', finishedAt: 200 },
      answer: captured.answer,
      expectedSettlementDigest: 'b'.repeat(64),
    };
    const input: V3SettlementContractInput = {
      target: {
        kind: 'delegation',
        chatId: CHAT_ID,
        delegationId: DELEGATION_ID,
        runGeneration: RUN_GENERATION,
      },
      registration: {
        chatId: CHAT_ID,
        delegationId: DELEGATION_ID,
        runGeneration: RUN_GENERATION,
        createdAt: 100,
        store: 'stream',
        origin: { kind: 'launch' },
        executionMode: 'background',
      },
      intent,
      settleAnswer: captured.settleAnswer,
    };
    const request = v3SettlementRequest(input);
    const retry: V3SettlementContractResult = {
      kind: 'retry',
      stage: 'lookup',
    };

    expect(request).toEqual({
      target: input.target,
      settlementKey: intent.settlementKey,
      resultIndex: intent.assertedResultIndex,
      outcome: intent.outcome,
      finalChanges: [],
      answer: { role: 'final', text: finalText },
      openRows: 'finalize',
    });
    expect(retry.kind).toBe('retry');
  });
});
