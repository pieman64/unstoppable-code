import { createHash } from 'node:crypto';
import {
  delegationReceiptEffect,
  fitDelegationReceiptAck,
} from '@canopy/desktop-shared/node/delegation/receipt-reply';
import {
  decodeDeltaJournalV2Record,
  DELTA_JOURNAL_V2_GENESIS_DIGEST,
  type DeltaJournalFrame,
} from '../lib/chat-delta-journal/format';

it('recovers a result entry atomically with its child-settle journal effect', () => {
  const target = {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: 'delegation',
    runGeneration: 0,
  };
  const row = {
    id: 'delegation:final',
    role: 'assistant',
    timestamp: 10,
    blocks: [{ type: 'text', text: 'final answer' }],
    parentBlockId: 'delegation',
    delegationSequence: 0,
    itemRevision: 0,
    final: true,
  };
  const settlementKey = 'settlement-1';
  const finalItemsDigest = 'a'.repeat(64);
  const result = {
    version: 1,
    kind: 'result',
    resultIndex: 1,
    runGeneration: 0,
    settlementKey,
    settlementDigest: 'b'.repeat(64),
    outcome: { status: 'completed', finishedAt: 10 },
    answer: { kind: 'none' },
    settlement: {
      streamRevision: 1,
      contentRevision: 1,
      finalItemCount: 1,
      finalItemsDigest,
    },
  };
  const record = {
    type: 'commit',
    v: 2,
    prev: DELTA_JOURNAL_V2_GENESIS_DIGEST,
    fromRevision: 0,
    toRevision: 1,
    mutationIds: ['settlement-mutation'],
    delta: {},
    transcripts: [
      {
        kind: 'child-settle',
        target,
        rows: [row],
        settlementKey,
      },
    ],
    streamRegistrations: [],
    descriptorUpdates: [
      {
        version: 1,
        target,
        expectedStreamRevision: 0,
        nextStreamRevision: 1,
        status: 'settled',
        latestRowTimestamp: 10,
        settleReceipt: {
          mutationId: settlementKey,
          scopeRevision: 1,
          streamRevision: 1,
          committedRowCount: 1,
          committedByteLength: 1,
          committedSha256: finalItemsDigest,
        },
      },
    ],
    registryEffects: [{ kind: 'delegation-result', target, entry: result }],
  };
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const digest = createHash('sha256').update(payload).digest('hex');
  const frame: DeltaJournalFrame = {
    offset: 0,
    end: 40 + payload.length,
    digest,
    payload,
  };

  const recovered: unknown = JSON.parse(
    JSON.stringify(decodeDeltaJournalV2Record(frame)),
  );

  expect(recovered).toMatchObject({
    transcripts: [
      {
        kind: 'child-settle',
        target,
        settlementKey,
      },
    ],
    registryEffects: [
      {
        kind: 'delegation-result',
        target,
        entry: result,
      },
    ],
  });
});

it('decodes a strict receipt effect (11c1)', () => {
  const fitted = fitDelegationReceiptAck(
    {
      chatId: 'chat',
      delegationId: 'delegation',
      receiptKind: 'command',
      key: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      operationId: '00000000-0000-4000-8000-000000000000',
      runGeneration: 1,
      operation: 'follow_up',
      admittedAt: 10,
    },
    {
      ok: false,
      error: { code: 'invalid_request', message: 'refused', retryable: false },
    },
  );
  if (!fitted.ok) throw new Error(fitted.reason);
  const record = {
    type: 'commit',
    v: 2,
    prev: DELTA_JOURNAL_V2_GENESIS_DIGEST,
    fromRevision: 0,
    toRevision: 1,
    mutationIds: ['receipt-mutation'],
    delta: {},
    transcripts: [],
    streamRegistrations: [],
    descriptorUpdates: [],
    registryEffects: [delegationReceiptEffect(fitted.entry)],
  };
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  const frame: DeltaJournalFrame = {
    offset: 0,
    end: 40 + payload.length,
    digest: createHash('sha256').update(payload).digest('hex'),
    payload,
  };
  expect(decodeDeltaJournalV2Record(frame)).toMatchObject({
    registryEffects: record.registryEffects,
  });
  const decodeEffects = (effects: unknown[]): unknown => {
    const payload = Buffer.from(
      JSON.stringify({ ...record, registryEffects: effects }),
      'utf8',
    );
    return decodeDeltaJournalV2Record({
      ...frame,
      payload,
      end: 40 + payload.length,
      digest: createHash('sha256').update(payload).digest('hex'),
    });
  };
  const effect = {
    kind: 'delegation-receipt',
    owner: { kind: 'chat_receipts', chatId: 'chat' },
    entry: fitted.entry,
  };
  expect(() => decodeEffects([effect, effect])).toThrow(
    'duplicate registry effects',
  );
  expect(() => decodeEffects([{ ...effect, extra: true }])).toThrow();
  expect(() =>
    decodeEffects([
      { ...effect, owner: { ...effect.owner, chatId: 'different' } },
    ]),
  ).toThrow();
  expect(() =>
    decodeEffects([{ ...effect, entry: { ...effect.entry, admittedAt: -1 } }]),
  ).toThrow();
});
