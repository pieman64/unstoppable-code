import { createHash } from 'node:crypto';
import type {
  DelegationChildRow,
  TranscriptBlocksReference,
} from '@canopy/agent-transcript';
import type { DelegationTranscriptSettleRequest } from '../transcript-port';
import {
  canonicalDelegationJson,
  delegationTranscriptRowDigest,
  delegationTranscriptSettlementDigest,
} from '../settlement-identity';

function row(id = 'a'): DelegationChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 123,
    parentBlockId: 'card',
    delegationSequence: 0,
    delegationSegment: 'native',
    itemRevision: 0,
    final: true,
    blocks: [{ type: 'text', text: 'hello' }],
  };
}
function request(): DelegationTranscriptSettleRequest {
  return {
    target: {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 1,
    },
    settlementKey: 'key',
    resultIndex: 7,
    outcome: { status: 'completed', finishedAt: 456 },
    finalChanges: [{ row: row() }],
    answer: null,
  };
}

describe('delegation settlement identity v1 golden vectors', () => {
  it('encodes keys in UTF-16 order, including numeric-looking keys, without dropping null', () => {
    expect(
      canonicalDelegationJson({ z: null, a: { b: 2, a: 1 }, '2': 2, '10': 10 }),
    ).toBe('{"10":10,"2":2,"a":{"a":1,"b":2},"z":null}');
    expect(canonicalDelegationJson({ a: 1, b: 2 })).toBe(
      canonicalDelegationJson({ b: 2, a: 1 }),
    );
    expect(canonicalDelegationJson({ a: null })).not.toBe(
      canonicalDelegationJson({}),
    );
  });

  it('rejects undefined, holes, cycles, nonfinite and non-JSON objects', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      { a: undefined },
      [undefined],
      new Array(1),
      NaN,
      Infinity,
      new Date(0),
      new Map([['a', 1]]),
      new (class Plain {
        readonly a = 1;
      })(),
      cycle,
    ]) {
      expect(() => canonicalDelegationJson(value)).toThrow(TypeError);
    }
  });

  it('accepts plain objects from another realm, such as structuredClone output', () => {
    // Under Jest, structuredClone returns objects whose prototype is the host
    // realm's Object.prototype, not the test realm's.
    const value = { b: [1, { c: null }], a: 'x' };
    const cloned: unknown = structuredClone(value);
    expect(canonicalDelegationJson(cloned)).toBe(
      canonicalDelegationJson(value),
    );
    expect(canonicalDelegationJson(cloned)).toBe(
      '{"a":"x","b":[1,{"c":null}]}',
    );
  });

  it('pins the logical row SHA-256 independent of property insertion order', () => {
    expect(delegationTranscriptRowDigest(row())).toBe(
      '08a2af0a50c3f9a0f78d9845650d05e3dfe555d7452df4d8ac9766be0f531db4',
    );
    const original = row();
    const reordered: DelegationChildRow = {
      blocks: original.blocks,
      final: original.final,
      itemRevision: original.itemRevision,
      delegationSegment: original.delegationSegment,
      delegationSequence: original.delegationSequence,
      parentBlockId: original.parentBlockId,
      timestamp: original.timestamp,
      role: original.role,
      id: original.id,
    };
    expect(delegationTranscriptRowDigest(reordered)).toBe(
      '08a2af0a50c3f9a0f78d9845650d05e3dfe555d7452df4d8ac9766be0f531db4',
    );
  });

  it('excludes exactly row/block storage fields, while committing logical text', () => {
    type TextBlock = Extract<
      DelegationChildRow['blocks'][number],
      { type: 'text' }
    >;
    type StoredTextBlock = TextBlock & {
      outputTruncated: boolean;
      inputRef: null;
      fullOutputRef: null;
      partialTextRef: null;
      finalTextRef: null;
    };
    const textBlock: TextBlock = {
      type: 'text',
      text: 'hello',
    };
    const stored: DelegationChildRow & {
      blocksRef: TranscriptBlocksReference;
      blocks: StoredTextBlock[];
    } = {
      ...row(),
      blocksRef: {
        version: 1,
        manifest: {
          version: 1,
          artifactId: 'transcript-artifact',
          byteLength: 5,
          sha256: 'a'.repeat(64),
          encoding: 'utf-8',
          mediaType: 'text/plain',
        },
        blockCount: 1,
      },
      blocks: [
        {
          ...textBlock,
          outputTruncated: true,
          textRef: {
            version: 1,
            artifactId: 'transcript-artifact',
            byteLength: 5,
            sha256: 'a'.repeat(64),
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
          inputRef: null,
          fullOutputRef: null,
          partialTextRef: null,
          finalTextRef: null,
        },
      ],
    };
    expect(delegationTranscriptRowDigest(stored)).toBe(
      '08a2af0a50c3f9a0f78d9845650d05e3dfe555d7452df4d8ac9766be0f531db4',
    );
    expect(
      delegationTranscriptRowDigest({
        ...row(),
        blocks: [{ type: 'text', text: 'changed' }],
      }),
    ).not.toBe(
      '08a2af0a50c3f9a0f78d9845650d05e3dfe555d7452df4d8ac9766be0f531db4',
    );
  });

  it.each([
    [null, '6ce41a87cadc9781b91bc6a892c44b7210fc3fe7791e41f741251779126f708e'],
    [
      { role: 'final', text: '' },
      '65eead4786b175532b17e549864fd9c264baacbaaca8f34b1e0cbf31c8a29213',
    ],
    [
      { role: 'final', text: '\ud800' },
      'de0c87689f96b282a0fb1ba89266ca0cbfbc91df6c5ca7b45b7ace3a860274e3',
    ],
    [
      { role: 'final', text: '\ufffd' },
      '7d99444d9de7c8e58138b8243af21cf58a7286052fc0028308692b36359f70a1',
    ],
  ] satisfies readonly (readonly [
    DelegationTranscriptSettleRequest['answer'],
    string,
  ])[])(
    'pins absent, empty and lossless code-unit answer identity: %j',
    (answer, expected) => {
      expect(
        delegationTranscriptSettlementDigest({ ...request(), answer }),
      ).toBe(expected);
    },
  );

  it('sorts non-ASCII item ids by UTF-16 code units, never locale order', () => {
    const rows = ['\ue000', '😀', 'é', 'z'].map((id) => ({ row: row(id) }));
    const input = { ...request(), finalChanges: rows };
    expect(delegationTranscriptSettlementDigest(input)).toBe(
      '06a4b4c0f5257fee3d805327aa5650894f2d1848d9ae0a3c584c11b92b783a1f',
    );
    expect(
      delegationTranscriptSettlementDigest({
        ...input,
        finalChanges: [...rows].reverse(),
      }),
    ).toBe('06a4b4c0f5257fee3d805327aa5650894f2d1848d9ae0a3c584c11b92b783a1f');
    expect(input.finalChanges.map(({ row: item }) => item.id)).toEqual([
      '\ue000',
      '😀',
      'é',
      'z',
    ]);
  });

  it('rejects duplicate ids, binds resultIndex/outcome/target, and excludes the lookup key', () => {
    expect(() =>
      delegationTranscriptSettlementDigest({
        ...request(),
        finalChanges: [{ row: row() }, { row: row() }],
      }),
    ).toThrow('Duplicate');
    expect(
      delegationTranscriptSettlementDigest({
        ...request(),
        settlementKey: 'another-key',
      }),
    ).toBe('6ce41a87cadc9781b91bc6a892c44b7210fc3fe7791e41f741251779126f708e');
    for (const changed of [
      { ...request(), resultIndex: 8 },
      { ...request(), outcome: { ...request().outcome, startedAt: 0 } },
      { ...request(), target: { ...request().target, runGeneration: 2 } },
    ]) {
      expect(delegationTranscriptSettlementDigest(changed)).not.toBe(
        '6ce41a87cadc9781b91bc6a892c44b7210fc3fe7791e41f741251779126f708e',
      );
    }
  });
});

const FINALIZE_VECTOR =
  '0d2f1298200cfaf0ac5627edef8c8a833d11b4815121fea617ae6e26a525f9d1';
const LOST_FINALIZE_VECTOR =
  '82f64cd150bf6b7b476a079ac4ee635af59bce37683db4fdf87838a24ad4638d';

describe('delegation settlement identity: 11c1 repair shapes', () => {
  function utf16Sha(text: string): string {
    return createHash('sha256')
      .update(Buffer.from(text, 'utf16le'))
      .digest('hex');
  }

  it('treats explicit reject as absent and pins finalize as a distinct identity', () => {
    const absent = delegationTranscriptSettlementDigest(request());
    expect(
      delegationTranscriptSettlementDigest({
        ...request(),
        openRows: 'reject',
      }),
    ).toBe(absent);
    expect(absent).toBe(
      '6ce41a87cadc9781b91bc6a892c44b7210fc3fe7791e41f741251779126f708e',
    );
    expect(
      delegationTranscriptSettlementDigest({
        ...request(),
        openRows: 'finalize',
      }),
    ).toBe(FINALIZE_VECTOR);
  });

  // Literals computed independently (Python: UTF-16LE with surrogatepass and the
  // same canonical JSON), not from this implementation.
  it.each([
    [
      'answer',
      'c1372bc956df7a9991e2370adb6f33e297a976bd6e68e5304ac0d16b737aa565',
      6,
      'eca8ec44156529ab84fe476b3d44b9374cc67c70babdbbcdbebbb83e1f7ff2a8',
    ],
    [
      '😀 astral',
      '70ee533bd3d60699d0e149313d1ef330a44a2edde83c23977e26ac6e4743e5a9',
      9,
      '177008703b1cadcc305870254678904a5bb19505eb7036a93cce2ebc0b8ac5e2',
    ],
    [
      '\ud800 lone',
      '3d87d7bb1c0d940ad24870edcbafff04e749acbb6e8a092080aa0cd62eca32de',
      6,
      '7b4943ad70b54f553adc6f6651b2d7714efd34e7004b08484d2b1634a42f34e2',
    ],
  ] as const)(
    'pins the text and lost answer identities to one literal: %j',
    (text, answerSha, length, digest) => {
      expect(utf16Sha(text)).toBe(answerSha);
      expect(text.length).toBe(length);
      expect(
        delegationTranscriptSettlementDigest({
          ...request(),
          answer: { role: 'final', text },
        }),
      ).toBe(digest);
      expect(
        delegationTranscriptSettlementDigest({
          ...request(),
          answer: { role: 'final', lost: { sha256: answerSha, length } },
        }),
      ).toBe(digest);
    },
  );

  it('pins a lost partial answer with finalize', () => {
    expect(
      delegationTranscriptSettlementDigest({
        ...request(),
        finalChanges: [],
        openRows: 'finalize',
        answer: {
          role: 'partial',
          lost: { sha256: utf16Sha('partial'), length: 7 },
        },
      }),
    ).toBe(LOST_FINALIZE_VECTOR);
  });

  it('rejects zero-length and malformed lost identities', () => {
    for (const lost of [
      { sha256: utf16Sha(''), length: 0 },
      { sha256: 'A'.repeat(64), length: 1 },
      { sha256: 'a'.repeat(63), length: 1 },
      { sha256: 'a'.repeat(64), length: 1.5 },
    ])
      expect(() =>
        delegationTranscriptSettlementDigest({
          ...request(),
          answer: { role: 'final', lost },
        }),
      ).toThrow('Invalid lost answer identity');
  });
});
