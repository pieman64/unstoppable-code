import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES,
  MANAGED_MESSAGE_RECEIPT_V2_MAX_BYTES,
  MANAGED_MESSAGE_UNRECORDABLE_OUTCOME,
  ManagedMessageReceiptDecodeError,
  boundManagedMessageSnapshot,
  cutJsonPreview,
  decodeManagedMessageReceiptV2,
  encodeManagedMessageReceiptV2,
  isVersionedManagedMessageReceipt,
  type ManagedMessageReceiptV2,
} from '../managed-message-receipt-v2';

const operationId = '7f0c0b6e-9a43-4c1e-8f61-1f2d3c4b5a69';
const requestHash = 'a'.repeat(64);
const jsonBytes = (value: string): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

function snapshot(
  overrides: Partial<AgentDelegationSnapshot> = {},
): AgentDelegationSnapshot {
  return {
    delegationId: 'delegate',
    status: 'running',
    outputTruncated: false,
    ...overrides,
  };
}

function complete(
  result: Extract<ManagedMessageReceiptV2, { status: 'complete' }>['result'],
): ManagedMessageReceiptV2 {
  return {
    version: 2,
    codec: 'stream',
    operationId,
    requestHash,
    status: 'complete',
    result,
  };
}

describe('managed message receipt v2', () => {
  it.each([
    ['ASCII', 'a'.repeat(10_000)],
    ['quotes and backslashes', '"\\'.repeat(5_000)],
    ['control characters', '\u0001\n\t'.repeat(3_000)],
    ['non-ASCII', 'é漢'.repeat(4_000)],
    ['surrogate pairs', '😀'.repeat(3_000)],
    ['lone surrogates', '\ud800x\udc00'.repeat(2_000)],
  ])(
    'cuts %s previews to the JSON byte budget without splitting pairs',
    (_label, value) => {
      const { text, cut } = cutJsonPreview(value);
      expect(cut).toBe(true);
      expect(jsonBytes(text)).toBeLessThanOrEqual(
        MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES,
      );
      // One more code unit would not fit, unless it would split a pair.
      const next = value.slice(0, text.length + 1);
      const pairSplit =
        /[\ud800-\udbff]$/.test(next) &&
        /^[\udc00-\udfff]/.test(value.slice(next.length));
      if (!pairSplit)
        expect(jsonBytes(next)).toBeGreaterThan(
          MANAGED_MESSAGE_PREVIEW_MAX_JSON_BYTES,
        );
      expect(
        /[\ud800-\udbff]$/.test(text) &&
          /^[\udc00-\udfff]/.test(value.slice(text.length)),
      ).toBe(false);
    },
  );

  it('keeps short previews, absent and empty values exactly', () => {
    const result = boundManagedMessageSnapshot(
      snapshot({ partialText: '', finalText: 'done' }),
    );
    expect(result).toEqual({
      ok: true,
      snapshot: {
        delegationId: 'delegate',
        status: 'running',
        partialText: '',
        finalText: 'done',
        outputTruncated: false,
      },
    });
    const absent = boundManagedMessageSnapshot(snapshot());
    expect(absent.ok && 'finalText' in absent.snapshot).toBe(false);
  });

  it('omits unlisted fields and marks shortened output', () => {
    const result = boundManagedMessageSnapshot(
      snapshot({
        finalText: 'x'.repeat(100_000),
        permissions: { writePaths: ['a'] },
        childDelegationIds: ['c'],
        workspaceDiscarded: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot).sort()).toEqual([
      'delegationId',
      'finalText',
      'outputTruncated',
      'status',
    ]);
    expect(result.snapshot.outputTruncated).toBe(true);
  });

  it('returns the fixed bounded failure for non-message controls and bad identity', () => {
    const failure = {
      ok: false,
      code: 'failed',
      error: MANAGED_MESSAGE_UNRECORDABLE_OUTCOME,
    };
    expect(
      boundManagedMessageSnapshot(
        snapshot({
          control: { operationId, operation: 'apply', status: 'completed' },
        }),
      ),
    ).toEqual(failure);
    expect(
      boundManagedMessageSnapshot(snapshot({ delegationId: 'a\nb' })),
    ).toEqual(failure);
  });

  it('fits the worst-case retained skeleton inside the receipt cap', () => {
    const control = '\u0001'.repeat(100_000);
    const result = boundManagedMessageSnapshot(
      snapshot({
        delegationId: '\u0001'.repeat(512),
        runGeneration: Number.MAX_SAFE_INTEGER,
        resultIndex: Number.MAX_SAFE_INTEGER,
        status: 'deadline_exceeded',
        phase: 'running',
        control: {
          operationId,
          operation: 'interrupt',
          status: 'failed',
          error: control,
        },
        error: {
          code: 'terminated_by_parent',
          message: control,
          retryable: false,
        },
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
          cachedInputTokens: Number.MAX_SAFE_INTEGER,
          cacheCreationInputTokens: Number.MAX_SAFE_INTEGER,
          costUsd: Number.MAX_VALUE,
        },
        stopReason: 'ancestor_stopped',
        stoppedBy: {
          kind: 'agent',
          depth: 9,
          delegationId: '\u0001'.repeat(512),
          description: '\u0001'.repeat(200),
        },
        cancelledByUser: true,
        requestedModelId: control,
        partialText: control,
        finalText: control,
      }),
    );
    expect(result.ok).toBe(true);
    const encoded = encodeManagedMessageReceiptV2(complete(result));
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(
      MANAGED_MESSAGE_RECEIPT_V2_MAX_BYTES,
    );
  });

  it('decodes its own encoding and rejects other versions and unknown keys', () => {
    const pending: ManagedMessageReceiptV2 = {
      version: 2,
      codec: 'stream',
      operationId,
      requestHash,
      status: 'pending',
    };
    const encoded = encodeManagedMessageReceiptV2(pending);
    const parsed: unknown = JSON.parse(encoded);
    expect(isVersionedManagedMessageReceipt(parsed)).toBe(true);
    expect(decodeManagedMessageReceiptV2(parsed)).toEqual(pending);
    expect(isVersionedManagedMessageReceipt({ operationId })).toBe(false);
    for (const bad of [
      { ...pending, version: 3 },
      { ...pending, extra: true },
      { ...pending, requestHash: 'short' },
      {
        ...pending,
        status: 'complete',
        result: {
          ok: true,
          snapshot: { delegationId: 'd', status: 'running' },
        },
      },
    ])
      expect(() => decodeManagedMessageReceiptV2(bad)).toThrow(
        ManagedMessageReceiptDecodeError,
      );
  });
});
